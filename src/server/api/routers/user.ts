import { z } from "zod";
import { createTRPCRouter, publicProcedure } from "~/server/api/trpc";
import { db } from "~/server/db";
import { users, userTemperatureProfile } from "~/server/db/schema";
import { cookies } from "next/headers";
import {
  authenticate,
  obtainFreshAccessToken,
  AuthError,
} from "~/server/eight/auth";
import { and, desc, eq } from "drizzle-orm";
import { type Token } from "~/server/eight/types";
import { TRPCError } from "@trpc/server";
import { adjustTemperature } from "~/app/api/temperatureCron/route";
import jwt from "jsonwebtoken";
import {
  userAiSettings,
  aiRecommendations,
  aiLiveAdjustments,
  pushSubscriptions,
  healthNights,
  temperatureEvents,
} from "~/server/db/schema";
import { getVapidKeys } from "~/server/push";
import {
  applyRecommendation,
  dismissRecommendation,
  generateRecommendationForUser,
  getAiSettingsOrDefaults,
  getFreshToken,
} from "~/server/ai/advisor";
import { AiError, isAiConfigured } from "~/server/ai/gemini";
import { collectSleepContext, fetchPodSessions } from "~/server/ai/sleepData";

class DatabaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseError";
  }
}

const checkAuthCookie = async (headers: Headers) => {
  const cookies = headers.get("cookie");
  console.log("Checking cookies");
  if (!cookies) {
    throw new AuthError(`Auth request failed. No cookies found.`, 401);
  }

  const token = cookies
    .split("; ")
    .find((row) => row.startsWith("8slpAutht="))
    ?.split("=")[1];
  console.log("Token:", token);

  if (!token) {
    throw new AuthError(`Auth request failed. No cookies found.`, 401);
  }
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET!) as {
      email: string;
    };
  } catch {
    throw new AuthError(`Auth request failed. Invalid token.`, 401);
  }

  return decoded;
};

export const userRouter = createTRPCRouter({
  checkLoginState: publicProcedure.query(async ({ ctx }) => {
    try {
      let decoded;
      try {
        decoded = await checkAuthCookie(ctx.headers);
      } catch (error) {
        if (error instanceof AuthError) {
          return { loginRequired: true };
        }
        throw error;
      }
      const email = decoded.email;

      const userList = await db
        .select()
        .from(users)
        .where(eq(users.email, email))
        .execute();

      if (userList.length !== 1 || userList[0] === undefined) {
        return { loginRequired: true };
      }

      const user = userList[0];

      // check if token is expired, and if so, refresh it
      if (user.eightTokenExpiresAt < new Date()) {
        console.log("Token expired, refreshing for user", user.email);
        try {
          const {
            eightAccessToken,
            eightRefreshToken,
            eightExpiresAtPosix: expiresAt,
          } = await obtainFreshAccessToken(
            user.eightRefreshToken,
            user.eightUserId,
          );

          await db
            .update(users)
            .set({
              eightAccessToken,
              eightRefreshToken,
              eightTokenExpiresAt: new Date(expiresAt),
            })
            .where(eq(users.email, email))
            .execute();

          return { loginRequired: false };
        } catch (error) {
          console.error("Token renewal failed:", error);
          return { loginRequired: true };
        }
      }
      return { loginRequired: false };
    } catch (error) {
      console.error("Error in checkLoginState:", error);
      throw new Error(
        "An unexpected error occurred while checking login state.",
      );
    }
  }),

  login: publicProcedure
    .input(
      z.object({
        email: z.string().email(),
        password: z.string(),
      }),
    )
    .mutation(async ({ input }) => {
      try {
        const authResult = await authenticateUser(input.email, input.password);

        const approvedEmails = process.env.APPROVED_EMAILS!.split(",").map(email => email.toLowerCase());

        if (!approvedEmails.includes(input.email.toLowerCase())) {
          throw new AuthError("Email not approved");
        }

        await saveUserToDatabase(input.email, authResult);

        const jwtSecret = process.env.JWT_SECRET;
        if (!jwtSecret) {
          throw new Error("JWT_SECRET is not defined in the environment");
        }

        const token = jwt.sign({ email: input.email }, jwtSecret, {
          expiresIn: "90d",
        });
        const threeMonthsInSeconds = 90 * 24 * 60 * 60; // 90 days

        cookies().set("8slpAutht", token, {
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          sameSite: "strict",
          maxAge: threeMonthsInSeconds,
          path: "/",
        });
        console.log("Saving token to cookie.");

        // Set HTTP-only cookie
        return {
          success: true,
        };
      } catch (error) {
        console.error("Error in login process:", error);
        if (error instanceof AuthError) {
          throw new Error(`Authentication failed: ${error.message}`);
        } else if (error instanceof DatabaseError) {
          throw new Error(
            "Failed to save login information. Please try again.",
          );
        } else {
          throw new Error(
            "An unexpected error occurred. Please try again later.",
          );
        }
      }
    }),
  logout: publicProcedure.mutation(async () => {
    try {
      cookies().set("8slpAutht", "", {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "strict",
        maxAge: 0,
        path: "/",
      });
      return {
        success: true,
      };
    } catch (error) {
      console.error("Error during logout:", error);
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "An unexpected error occurred during logout.",
      });
    }
  }),

  getUserTemperatureProfile: publicProcedure.query(async ({ ctx }) => {
    try {
      const decoded = await checkAuthCookie(ctx.headers);

      const profile = await db.query.userTemperatureProfile.findFirst({
        where: eq(userTemperatureProfile.email, decoded.email),
      });

      if (!profile) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Temperature profile not found for this user.",
        });
      }

      return profile;
    } catch (error) {
      console.error("Error fetching user temperature profile:", error);
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message:
          "An unexpected error occurred while fetching the temperature profile.",
      });
    }
  }),

  updateUserTemperatureProfile: publicProcedure
    .input(
      z.object({
        bedTime: z.string().time(),
        wakeupTime: z.string().time(),
        initialSleepLevel: z.number().int().min(-100).max(100),
        deepSleepLevel: z.number().int().min(-100).max(100),
        midStageSleepLevel: z.number().int().min(-100).max(100),
        finalSleepLevel: z.number().int().min(-100).max(100),
        timezoneTZ: z.string().max(50),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      try {
        const decoded = await checkAuthCookie(ctx.headers);
        const updatedProfile = {
          email: decoded.email,
          bedTime: input.bedTime,
          wakeupTime: input.wakeupTime,
          initialSleepLevel: input.initialSleepLevel,
          deepSleepLevel: input.deepSleepLevel,
          midStageSleepLevel: input.midStageSleepLevel,
          finalSleepLevel: input.finalSleepLevel,
          timezoneTZ: input.timezoneTZ,
          updatedAt: new Date(),
        };
        console.log("Updated profile:", updatedProfile);

        await db
          .insert(userTemperatureProfile)
          .values(updatedProfile)
          .onConflictDoUpdate({
            target: userTemperatureProfile.email,
            set: {
              bedTime: input.bedTime,
              wakeupTime: input.wakeupTime,
              initialSleepLevel: input.initialSleepLevel,
              deepSleepLevel: input.deepSleepLevel,
              midStageSleepLevel: input.midStageSleepLevel,
              finalSleepLevel: input.finalSleepLevel,
              timezoneTZ: input.timezoneTZ,
              updatedAt: new Date(),
            },
          })
          .execute();

        await adjustTemperature();

        return { success: true };
      } catch (error) {
        console.error("Error updating user temperature profile:", error);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message:
            "An unexpected error occurred while updating the temperature profile.",
        });
      }
    }),

  getAiSettings: publicProcedure.query(async ({ ctx }) => {
    const decoded = await checkAuthCookie(ctx.headers);
    const settings = await getAiSettingsOrDefaults(decoded.email);
    return {
      aiEnabled: settings.aiEnabled,
      autoApply: settings.autoApply,
      liveTuningEnabled: settings.liveTuningEnabled,
      displayUnit: settings.displayUnit === "level" ? ("level" as const) : ("celsius" as const),
      sleepGoal: settings.sleepGoal,
      maxDailyShift: settings.maxDailyShift,
      aiAvailable: isAiConfigured(),
    };
  }),

  updateAiSettings: publicProcedure
    .input(
      z.object({
        aiEnabled: z.boolean(),
        autoApply: z.boolean(),
        liveTuningEnabled: z.boolean(),
        displayUnit: z.enum(["celsius", "level"]),
        sleepGoal: z.string().max(500).nullable(),
        maxDailyShift: z.number().int().min(5).max(40),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const decoded = await checkAuthCookie(ctx.headers);
      await db
        .insert(userAiSettings)
        .values({
          email: decoded.email,
          aiEnabled: input.aiEnabled,
          autoApply: input.autoApply,
          liveTuningEnabled: input.liveTuningEnabled,
          displayUnit: input.displayUnit,
          sleepGoal: input.sleepGoal,
          maxDailyShift: input.maxDailyShift,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: userAiSettings.email,
          set: {
            aiEnabled: input.aiEnabled,
            autoApply: input.autoApply,
            liveTuningEnabled: input.liveTuningEnabled,
            displayUnit: input.displayUnit,
            sleepGoal: input.sleepGoal,
            maxDailyShift: input.maxDailyShift,
            updatedAt: new Date(),
          },
        })
        .execute();
      return { success: true };
    }),

  getHealthImportInfo: publicProcedure.query(async ({ ctx }) => {
    const decoded = await checkAuthCookie(ctx.headers);
    const existing = await db.query.userAiSettings.findFirst({
      where: eq(userAiSettings.email, decoded.email),
    });
    let token = existing?.healthImportToken ?? null;
    if (!token) {
      token = crypto.randomUUID().replace(/-/g, "");
      await db
        .insert(userAiSettings)
        .values({ email: decoded.email, healthImportToken: token })
        .onConflictDoUpdate({
          target: userAiSettings.email,
          set: { healthImportToken: token, updatedAt: new Date() },
        })
        .execute();
    }
    const lastNight = await db
      .select()
      .from(healthNights)
      .where(eq(healthNights.email, decoded.email))
      .orderBy(desc(healthNights.night))
      .limit(1);
    return {
      token,
      lastImportNight: lastNight[0]?.night ?? null,
      lastImportScore: lastNight[0]?.score ?? null,
    };
  }),

  getPushPublicKey: publicProcedure.query(async ({ ctx }) => {
    const decoded = await checkAuthCookie(ctx.headers);
    const keys = await getVapidKeys();
    const existing = await db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.email, decoded.email))
      .limit(1);
    return { publicKey: keys.publicKey, subscribed: existing.length > 0 };
  }),

  subscribePush: publicProcedure
    .input(
      z.object({
        endpoint: z.string().url().max(1000),
        p256dh: z.string().min(1).max(500),
        auth: z.string().min(1).max(500),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const decoded = await checkAuthCookie(ctx.headers);
      await db
        .insert(pushSubscriptions)
        .values({
          email: decoded.email,
          endpoint: input.endpoint,
          p256dh: input.p256dh,
          auth: input.auth,
        })
        .onConflictDoUpdate({
          target: pushSubscriptions.endpoint,
          set: {
            email: decoded.email,
            p256dh: input.p256dh,
            auth: input.auth,
          },
        })
        .execute();
      return { success: true };
    }),

  unsubscribePush: publicProcedure
    .input(z.object({ endpoint: z.string().max(1000) }))
    .mutation(async ({ input, ctx }) => {
      const decoded = await checkAuthCookie(ctx.headers);
      await db
        .delete(pushSubscriptions)
        .where(
          and(
            eq(pushSubscriptions.email, decoded.email),
            eq(pushSubscriptions.endpoint, input.endpoint),
          ),
        )
        .execute();
      return { success: true };
    }),

  // Timeline of one night: every temperature change we sent to the pod, plus
  // the pod's own measurements for that night (tosses, bed temp, heart rate).
  getNightTimeline: publicProcedure
    .input(z.object({ night: z.string().max(10).optional() }).optional())
    .query(async ({ input, ctx }) => {
      const decoded = await checkAuthCookie(ctx.headers);
      const user = await db.query.users.findFirst({
        where: eq(users.email, decoded.email),
      });
      const profile = await db.query.userTemperatureProfile.findFirst({
        where: eq(userTemperatureProfile.email, decoded.email),
      });
      const timezone = profile?.timezoneTZ ?? "UTC";

      let sessionInfo: {
        night: string;
        sleepStart: string | null;
        sleepEnd: string | null;
        tnt: [string, number][];
        tempBedC: [string, number][];
        heartRate: [string, number][];
        stageHours: Record<string, number>;
      } | null = null;

      if (user) {
        try {
          const token = await getFreshToken(user);
          const sessions = await fetchPodSessions(token, user.eightUserId);
          const completed = sessions
            .filter((s) => s.sleepEnd)
            .sort((a, b) => (a.sleepEnd! < b.sleepEnd! ? -1 : 1));
          const chosen = input?.night
            ? completed.find(
                (s) =>
                  new Date(s.sleepEnd!).toLocaleDateString("en-CA", {
                    timeZone: timezone,
                  }) === input.night,
              )
            : completed[completed.length - 1];
          if (chosen) {
            const summary = chosen.stageSummary ?? {};
            const stageHours: Record<string, number> = {};
            for (const [k, seconds] of [
              ["deep", summary.deepDuration],
              ["rem", summary.remDuration],
              ["light", summary.lightDuration],
              ["awake", summary.awakeDuration],
            ] as [string, number | null | undefined][]) {
              if (seconds != null) {
                stageHours[k] = Math.round((seconds / 3600) * 10) / 10;
              }
            }
            sessionInfo = {
              night: new Date(chosen.sleepEnd!).toLocaleDateString("en-CA", {
                timeZone: timezone,
              }),
              sleepStart: chosen.sleepStart ?? null,
              sleepEnd: chosen.sleepEnd ?? null,
              tnt: chosen.timeseries?.tnt ?? [],
              tempBedC: chosen.timeseries?.tempBedC ?? [],
              heartRate: chosen.timeseries?.heartRate ?? [],
              stageHours,
            };
          }
        } catch (error) {
          console.error("Night timeline: pod fetch failed:", error);
        }
      }

      const night = input?.night ?? sessionInfo?.night ?? null;
      const events = night
        ? await db
            .select()
            .from(temperatureEvents)
            .where(
              and(
                eq(temperatureEvents.email, decoded.email),
                eq(temperatureEvents.night, night),
              ),
            )
            .orderBy(temperatureEvents.at)
        : [];

      return { night, timezone, events, session: sessionInfo };
    }),

  getLiveAdjustments: publicProcedure.query(async ({ ctx }) => {
    const decoded = await checkAuthCookie(ctx.headers);
    return await db
      .select()
      .from(aiLiveAdjustments)
      .where(eq(aiLiveAdjustments.email, decoded.email))
      .orderBy(desc(aiLiveAdjustments.id))
      .limit(12);
  }),

  getSleepSummary: publicProcedure.query(async ({ ctx }) => {
    const decoded = await checkAuthCookie(ctx.headers);
    const user = await db.query.users.findFirst({
      where: eq(users.email, decoded.email),
    });
    if (!user) {
      throw new TRPCError({ code: "NOT_FOUND", message: "User not found." });
    }
    const profile = await db.query.userTemperatureProfile.findFirst({
      where: eq(userTemperatureProfile.email, decoded.email),
    });
    const timezone = profile?.timezoneTZ ?? "UTC";
    try {
      const token = await getFreshToken(user);
      return await collectSleepContext(
        token,
        user.eightUserId,
        timezone,
        decoded.email,
      );
    } catch (error) {
      console.error("Error fetching sleep summary:", error);
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Could not fetch sleep data from Eight Sleep.",
      });
    }
  }),

  getAiRecommendations: publicProcedure.query(async ({ ctx }) => {
    const decoded = await checkAuthCookie(ctx.headers);
    return await db
      .select()
      .from(aiRecommendations)
      .where(eq(aiRecommendations.email, decoded.email))
      .orderBy(desc(aiRecommendations.id))
      .limit(5);
  }),

  generateAiRecommendation: publicProcedure.mutation(async ({ ctx }) => {
    const decoded = await checkAuthCookie(ctx.headers);
    try {
      return await generateRecommendationForUser(decoded.email, "manual");
    } catch (error) {
      console.error("Error generating AI recommendation:", error);
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message:
          error instanceof AiError
            ? error.message
            : "An unexpected error occurred while generating the recommendation.",
      });
    }
  }),

  applyAiRecommendation: publicProcedure
    .input(z.object({ id: z.number().int() }))
    .mutation(async ({ input, ctx }) => {
      const decoded = await checkAuthCookie(ctx.headers);
      try {
        await applyRecommendation(decoded.email, input.id);
        return { success: true };
      } catch (error) {
        console.error("Error applying AI recommendation:", error);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message:
            error instanceof AiError
              ? error.message
              : "An unexpected error occurred while applying the recommendation.",
        });
      }
    }),

  dismissAiRecommendation: publicProcedure
    .input(z.object({ id: z.number().int() }))
    .mutation(async ({ input, ctx }) => {
      const decoded = await checkAuthCookie(ctx.headers);
      try {
        await dismissRecommendation(decoded.email, input.id);
        return { success: true };
      } catch (error) {
        console.error("Error dismissing AI recommendation:", error);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message:
            error instanceof AiError
              ? error.message
              : "An unexpected error occurred while dismissing the recommendation.",
        });
      }
    }),

  deleteUserTemperatureProfile: publicProcedure.mutation(async ({ ctx }) => {
    try {
      const decoded = await checkAuthCookie(ctx.headers);
      const email = decoded.email;

      // Delete user temperature profile
      const result = await db
        .delete(userTemperatureProfile)
        .where(eq(userTemperatureProfile.email, email))
        .execute();

      if (result.rowCount === 0) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Temperature profile not found for this user.",
        });
      }

      return {
        success: true,
        message: "User temperature profile deleted successfully",
      };
    } catch (error) {
      console.error("Error deleting user temperature profile:", error);
      if (error instanceof TRPCError) {
        throw error;
      }
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message:
          "An unexpected error occurred while deleting the user temperature profile.",
      });
    }
  }),
});

async function authenticateUser(email: string, password: string) {
  try {
    return await authenticate(email, password);
  } catch (error) {
    if (error instanceof AuthError) {
      throw error; // Propagate the AuthError with its specific message
    } else {
      throw new AuthError("Failed to authenticate user");
    }
  }
}

async function saveUserToDatabase(email: string, authResult: Token) {
  try {
    await db
      .insert(users)
      .values({
        email,
        eightAccessToken: authResult.eightAccessToken,
        eightRefreshToken: authResult.eightRefreshToken,
        eightTokenExpiresAt: new Date(authResult.eightExpiresAtPosix),
        eightUserId: authResult.eightUserId,
      })
      .onConflictDoUpdate({
        target: users.email,
        set: {
          eightAccessToken: authResult.eightAccessToken,
          eightRefreshToken: authResult.eightRefreshToken,
          eightTokenExpiresAt: new Date(authResult.eightExpiresAtPosix),
          eightUserId: authResult.eightUserId,
        },
      })
      .execute();
  } catch (error) {
    console.error("Database operation failed:", error);
    throw new DatabaseError("Failed to save user token to database.");
  }
}
