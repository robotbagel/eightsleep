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
import { and, desc, eq, gte, lte } from "drizzle-orm";
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
  nightMetrics,
  sleepFeedback,
} from "~/server/db/schema";
import { getVapidKeys } from "~/server/push";
import { minutesSinceTimeOfDay } from "~/server/ai/time";
import { rawToCelsius } from "~/lib/temperature";
import {
  applyRecommendation,
  dismissRecommendation,
  generateRecommendationForUser,
  getAiSettingsOrDefaults,
  getFreshToken,
  readLedgerForApp,
  reassessToday,
} from "~/server/ai/advisor";
import {
  AiError,
  isAiConfigured,
  type RecommendationRationale,
} from "~/server/ai/gemini";
import {
  awakeAfterOnsetHours,
  collectSleepContext,
  fetchPodSessions,
} from "~/server/ai/sleepData";
import {
  aggregate,
  byWeekday,
  pagesForDays,
  persistNightMetrics,
  readNightMetrics,
  sessionsToMetrics,
  shiftDate,
  syncNightMetrics,
  type MetricKey,
  type NightMetric,
} from "~/server/ai/history";

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

        // A hand edit is a correction, and the loop must not simply overwrite
        // it the next morning as if it never happened. Record which stages
        // moved and in which direction as feedback of the strongest kind: the
        // sleeper went and changed it themselves.
        try {
          const before = await db.query.userTemperatureProfile.findFirst({
            where: eq(userTemperatureProfile.email, decoded.email),
          });
          if (before) {
            const moves: [string, number, number][] = [
              ["initial", before.initialSleepLevel, input.initialSleepLevel],
              [
                "deep",
                before.deepSleepLevel ?? before.midStageSleepLevel,
                input.deepSleepLevel,
              ],
              ["mid", before.midStageSleepLevel, input.midStageSleepLevel],
              ["final", before.finalSleepLevel, input.finalSleepLevel],
            ];
            const changed = moves.filter(([, from, to]) => from !== to);
            if (changed.length > 0) {
              const warmer = changed.filter(([, from, to]) => to > from).length;
              const cooler = changed.length - warmer;
              const night = new Date().toLocaleDateString("en-CA", {
                timeZone: input.timezoneTZ,
              });
              await db
                .delete(sleepFeedback)
                .where(
                  and(
                    eq(sleepFeedback.email, decoded.email),
                    eq(sleepFeedback.night, night),
                  ),
                );
              await db.insert(sleepFeedback).values({
                email: decoded.email,
                night,
                felt: warmer > cooler ? "too_cold" : "too_hot",
                whenFelt:
                  changed.length === 1
                    ? changed[0]![0] === "initial"
                      ? "falling_asleep"
                      : changed[0]![0] === "final"
                        ? "morning"
                        : "middle"
                    : "not_sure",
                note: `Adjusted by hand: ${changed
                  .map(
                    ([stage, from, to]) =>
                      `${stage} ${rawToCelsius(from)}°C to ${rawToCelsius(to)}°C`,
                  )
                  .join(", ")}.`,
              });
            }
          }
        } catch (error) {
          console.error("Could not record the manual adjustment:", error);
        }

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

  // One night, whole: the pod's own record, the temperature changes we sent
  // during it, and the list of nights either side so the view can be swiped.
  //
  // Event lookup is by TIME RANGE, not by night key. `temperatureEvents.night`
  // comes from nightKeyFor(), which labels a night by the date it STARTED,
  // while every other night key in the app (and the pod's own session) is the
  // date you WOKE. Matching those two strings directly pulled in the wrong
  // night's events entirely — an off-by-one-day bug that made it look as if
  // the AI had not changed anything.
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
        /** Session start (first presence), which is where `stages` begins. */
        sessionStart: string | null;
        sleepStart: string | null;
        sleepEnd: string | null;
        tnt: [string, number][];
        tempBedC: [string, number][];
        tempRoomC: [string, number][];
        heartRate: [string, number][];
        hrv: [string, number][];
        respiratoryRate: [string, number][];
        shortAwakes: [string, number][];
        /** Hypnogram: consecutive runs from sessionStart, seconds each. */
        stages: { stage: string; duration: number }[];
        stageHours: Record<string, number>;
      } | null = null;
      let metrics: NightMetric | null = null;
      let availableNights: string[] = [];

      if (user) {
        try {
          const token = await getFreshToken(user);
          const sessions = await fetchPodSessions(token, user.eightUserId);
          const completed = sessions
            .filter((s) => s.sleepEnd)
            .sort((a, b) => (a.sleepEnd! < b.sleepEnd! ? -1 : 1));

          // Every fetch feeds the long-range cache, so the comparison view is
          // already warm by the time it is opened. AWAITED, because the night
          // this request is about is then read back OUT of the cache — see
          // below.
          const batch = sessionsToMetrics(completed, timezone);
          await persistNightMetrics(decoded.email, batch);

          const nightOf = (s: (typeof completed)[number]) =>
            new Date(s.sleepEnd!).toLocaleDateString("en-CA", {
              timeZone: timezone,
            });
          const chosen = input?.night
            ? completed.find((s) => nightOf(s) === input.night)
            : completed[completed.length - 1];

          if (chosen) {
            const summary = chosen.stageSummary ?? {};
            const stageHours: Record<string, number> = {};
            for (const [k, seconds] of [
              ["deep", summary.deepDuration],
              ["rem", summary.remDuration],
              ["light", summary.lightDuration],
            ] as [string, number | null | undefined][]) {
              if (seconds != null) {
                stageHours[k] = Math.round((seconds / 3600) * 10) / 10;
              }
            }
            // Awake = interruptions of sleep, not the whole time in bed.
            const waso = awakeAfterOnsetHours(chosen);
            if (waso != null) stageHours.awake = Math.round(waso * 10) / 10;
            sessionInfo = {
              night: nightOf(chosen),
              sessionStart: chosen.ts ?? chosen.sleepStart ?? null,
              sleepStart: chosen.sleepStart ?? null,
              sleepEnd: chosen.sleepEnd ?? null,
              tnt: chosen.timeseries?.tnt ?? [],
              tempBedC: chosen.timeseries?.tempBedC ?? [],
              tempRoomC: chosen.timeseries?.tempRoomC ?? [],
              heartRate: chosen.timeseries?.heartRate ?? [],
              hrv: chosen.timeseries?.rmssd ?? chosen.timeseries?.hrv ?? [],
              respiratoryRate:
                chosen.timeseries?.respiratoryRate ??
                chosen.timeseries?.nemeanRespiratoryRate ??
                [],
              shortAwakes: chosen.timeseries?.shortAwakes ?? [],
              stages: (chosen.stages ?? []).map((s) => ({
                stage: s.stage,
                duration: s.duration,
              })),
              stageHours,
            };
            // ONE source of truth. This used to hand back the freshly
            // computed row, while every other view read the stored one — so
            // the hero card showed a number that drifted on every reload (the
            // overall score is measured against the circular-mean bedtime of
            // whatever window the fetch happened to return) and disagreed
            // with the Recent tab beside it. Stored value wins, always.
            const stored = await readNightMetrics(
              decoded.email,
              sessionInfo.night,
              sessionInfo.night,
            );
            metrics =
              stored[0] ??
              batch.find((m) => m.night === sessionInfo!.night) ??
              null;
          }
        } catch (error) {
          console.error("Night timeline: pod fetch failed:", error);
        }
      }

      // The navigable list comes from the cache, so swiping reaches further
      // back than the single page of sessions this request fetched.
      try {
        const cached = await db
          .select({ night: nightMetrics.night })
          .from(nightMetrics)
          .where(eq(nightMetrics.email, decoded.email));
        availableNights = [...new Set(cached.map((row) => row.night))].sort();
      } catch (error) {
        console.error("Night timeline: night list failed:", error);
      }
      if (sessionInfo && !availableNights.includes(sessionInfo.night)) {
        availableNights = [...availableNights, sessionInfo.night].sort();
      }

      const night = input?.night ?? sessionInfo?.night ?? null;

      let events: (typeof temperatureEvents.$inferSelect)[] = [];
      try {
        if (sessionInfo?.sleepEnd) {
          // Pre-heating starts an hour before bedtime and presence can begin
          // later than that, so open the window generously on the early side.
          const from = new Date(
            new Date(
              sessionInfo.sessionStart ?? sessionInfo.sleepStart ?? sessionInfo.sleepEnd,
            ).getTime() -
              5 * 60 * 60 * 1000,
          );
          const to = new Date(
            new Date(sessionInfo.sleepEnd).getTime() + 2 * 60 * 60 * 1000,
          );
          events = await db
            .select()
            .from(temperatureEvents)
            .where(
              and(
                eq(temperatureEvents.email, decoded.email),
                gte(temperatureEvents.at, from),
                lte(temperatureEvents.at, to),
              ),
            )
            .orderBy(temperatureEvents.at);
        } else if (night) {
          // No session for this night: fall back to the stored night key,
          // which for a night with no pod record is the best we have.
          events = await db
            .select()
            .from(temperatureEvents)
            .where(
              and(
                eq(temperatureEvents.email, decoded.email),
                eq(temperatureEvents.night, night),
              ),
            )
            .orderBy(temperatureEvents.at);
        }
      } catch (error) {
        console.error("Night timeline: event lookup failed:", error);
      }

      return {
        night,
        timezone,
        events,
        session: sessionInfo,
        metrics,
        availableNights,
      };
    }),

  // 7 / 14 / 30-night comparison, served from the night-metrics cache and
  // topped up from the pod only when the requested window is not covered.
  getSleepHistory: publicProcedure
    .input(z.object({ days: z.union([z.literal(7), z.literal(14), z.literal(30)]) }))
    .query(async ({ input, ctx }) => {
      const decoded = await checkAuthCookie(ctx.headers);
      const user = await db.query.users.findFirst({
        where: eq(users.email, decoded.email),
      });
      const profile = await db.query.userTemperatureProfile.findFirst({
        where: eq(userTemperatureProfile.email, decoded.email),
      });
      const timezone = profile?.timezoneTZ ?? "UTC";
      const today = new Date().toLocaleDateString("en-CA", {
        timeZone: timezone,
      });

      const from = shiftDate(today, -(input.days - 1));
      const previousFrom = shiftDate(today, -(input.days * 2 - 1));
      const previousTo = shiftDate(from, -1);

      let cached = await readNightMetrics(decoded.email, previousFrom, today);
      // Only reach for more pod pages when the cache cannot cover the window,
      // so the common case stays a single database read.
      const covered = cached.filter((n) => n.night >= from).length;
      const expected = Math.min(input.days, 30);
      if (user && covered < expected) {
        try {
          const token = await getFreshToken(user);
          await syncNightMetrics(
            decoded.email,
            token,
            user.eightUserId,
            timezone,
            pagesForDays(input.days * 2),
          );
          cached = await readNightMetrics(decoded.email, previousFrom, today);
        } catch (error) {
          console.error("Sleep history: pod sync failed:", error);
        }
      }

      const window = cached.filter((n) => n.night >= from);
      const previous = cached.filter(
        (n) => n.night >= previousFrom && n.night <= previousTo,
      );

      const keys: MetricKey[] = [
        "score",
        "asleepHours",
        "deepHours",
        "remHours",
        "awakeHours",
        "tosses",
        "restingHeartRate",
        "hrv",
        "respiratoryRate",
        "avgBedTempC",
        "bedtimeMinutes",
      ];

      return {
        days: input.days,
        timezone,
        from,
        to: today,
        nights: window,
        previousNights: previous,
        aggregates: keys.map((key) => aggregate(window, previous, key)),
        weekday: {
          score: byWeekday(window, "score"),
          asleepHours: byWeekday(window, "asleepHours"),
          deepHours: byWeekday(window, "deepHours"),
        },
      };
    }),

  // The three nights that matter to the question "how did I sleep, and how
  // will I sleep tonight": the night before last, last night, and tonight —
  // the last of which is a PREDICTION, carried by the recommendation that
  // governs it.
  //
  // Night keys are wake dates, recommendation `forDate` is a night-START
  // date, so the recommendation made on D governs the night you wake from on
  // D+1. Getting that offset wrong silently compares a plan with the night
  // that preceded it.
  getNightOutlook: publicProcedure.query(async ({ ctx }) => {
    const decoded = await checkAuthCookie(ctx.headers);
    const user = await db.query.users.findFirst({
      where: eq(users.email, decoded.email),
    });
    const profile = await db.query.userTemperatureProfile.findFirst({
      where: eq(userTemperatureProfile.email, decoded.email),
    });
    const timezone = profile?.timezoneTZ ?? "UTC";
    const todayKey = new Date().toLocaleDateString("en-CA", {
      timeZone: timezone,
    });

    let nights = await readNightMetrics(
      decoded.email,
      shiftDate(todayKey, -10),
      todayKey,
    );
    // The cache is filled by every night fetch, but a cold session (or a
    // brand-new night) can beat it, so top it up rather than show nothing.
    if (nights.length < 2 && user) {
      try {
        const token = await getFreshToken(user);
        await syncNightMetrics(
          decoded.email,
          token,
          user.eightUserId,
          timezone,
          1,
        );
        nights = await readNightMetrics(
          decoded.email,
          shiftDate(todayKey, -10),
          todayKey,
        );
      } catch (error) {
        console.error("Night outlook: pod sync failed:", error);
      }
    }

    const lastNight = nights[nights.length - 1] ?? null;
    const nightBefore = nights[nights.length - 2] ?? null;

    const recommendations = await db
      .select()
      .from(aiRecommendations)
      .where(eq(aiRecommendations.email, decoded.email))
      .orderBy(desc(aiRecommendations.id))
      .limit(10);

    const parse = (json: string | null) => {
      if (!json) return null;
      try {
        return JSON.parse(json) as {
          expectation?: string;
          forecast?: {
            expectedScoreLow: number;
            expectedScoreHigh: number;
            expectedDeepHours?: number | null;
            expectedTosses?: number | null;
          } | null;
        };
      } catch {
        return null;
      }
    };

    const ranFor = (nightKey: string) =>
      recommendations.find(
        (r) =>
          r.forDate === shiftDate(nightKey, -1) &&
          (r.status === "applied" || r.status === "auto_applied"),
      ) ?? null;

    // Tonight begins this evening, so it is governed by today's assessment.
    const forTonight =
      recommendations.find(
        (r) =>
          r.forDate === todayKey &&
          (r.status === "applied" ||
            r.status === "auto_applied" ||
            r.status === "pending"),
      ) ?? null;
    const tonightRationale = parse(forTonight?.rationaleJson ?? null);

    // How the previous prediction actually landed.
    const lastNightRec = lastNight ? ranFor(lastNight.night) : null;
    const lastNightForecast = parse(lastNightRec?.rationaleJson ?? null)
      ?.forecast;
    // Both sides of this comparison must be on the SAME scale. The forecast
    // band comes from the ledger's mean THERMAL score, so it is checked
    // against the night's thermal score — checking it against the overall
    // score (half duration, a third bedtime) reported misses that never were.
    const actualThermal = lastNight?.thermalScore ?? null;
    const accuracy =
      actualThermal != null && lastNightForecast
        ? {
            night: lastNight!.night,
            low: lastNightForecast.expectedScoreLow,
            high: lastNightForecast.expectedScoreHigh,
            actual: actualThermal,
            hit:
              actualThermal >= lastNightForecast.expectedScoreLow &&
              actualThermal <= lastNightForecast.expectedScoreHigh,
          }
        : null;

    return {
      timezone,
      todayKey,
      nightBefore,
      lastNight,
      tonight: {
        /** The night starting this evening, keyed by the date you will wake. */
        night: shiftDate(todayKey, 1),
        planned: forTonight != null,
        status: forTonight?.status ?? null,
        confidence: forTonight?.confidence ?? null,
        forecast: tonightRationale?.forecast ?? null,
        expectation: tonightRationale?.expectation ?? null,
      },
      accuracy,
    };
  }),

  // What the pod has actually been running, night by night, plus what is
  // loaded for tonight and anything the AI is proposing.
  //
  // Both `temperatureEvents.night` and `aiRecommendations.forDate` are keyed
  // by the date a night STARTED, so they line up with each other directly —
  // it is only the pod's own sessions (keyed by the wake date) that need the
  // time-range treatment.
  getTemperaturePlan: publicProcedure
    .input(z.object({ days: z.number().int().min(3).max(21) }).optional())
    .query(async ({ input, ctx }) => {
      const decoded = await checkAuthCookie(ctx.headers);
      const profile = await db.query.userTemperatureProfile.findFirst({
        where: eq(userTemperatureProfile.email, decoded.email),
      });
      if (!profile) {
        return {
          timezone: "UTC",
          bedTime: null,
          wakeupTime: null,
          todayKey: null,
          tonight: null,
          lastNight: null,
          proposed: null,
          latest: null,
          history: [],
        };
      }
      const timezone = profile.timezoneTZ;
      const days = input?.days ?? 7;

      const tonight = {
        initial: profile.initialSleepLevel,
        deep: profile.deepSleepLevel ?? profile.midStageSleepLevel,
        mid: profile.midStageSleepLevel,
        final: profile.finalSleepLevel,
      };

      // The night that begins this evening is keyed by today's local date,
      // the same key nightKeyFor() writes for events sent after wake-up.
      const todayKey = new Date().toLocaleDateString("en-CA", { timeZone: timezone });
      const from = shiftDate(todayKey, -(days + 1));

      const events = await db
        .select()
        .from(temperatureEvents)
        .where(
          and(
            eq(temperatureEvents.email, decoded.email),
            gte(temperatureEvents.night, from),
          ),
        )
        .orderBy(temperatureEvents.at);

      const recommendations = await db
        .select()
        .from(aiRecommendations)
        .where(
          and(
            eq(aiRecommendations.email, decoded.email),
            gte(aiRecommendations.forDate, from),
          ),
        )
        .orderBy(aiRecommendations.id);

      type Row = {
        night: string;
        initial: number | null;
        deep: number | null;
        mid: number | null;
        final: number | null;
        /** Did a recommendation actually take effect for this night? */
        aiChanged: boolean;
        aiStatus: string | null;
        liveNudges: number;
        /** Did the sleeper move the dial themselves that night? */
        manualOverride: boolean;
      };

      const byNight = new Map<string, Row>();
      for (const event of events) {
        const row = byNight.get(event.night) ?? {
          night: event.night,
          initial: null,
          deep: null,
          mid: null,
          final: null,
          aiChanged: false,
          aiStatus: null,
          liveNudges: 0,
          manualOverride: false,
        };
        if (event.source === "live") {
          row.liveNudges += 1;
        } else if (event.source === "manual") {
          // A hand adjustment is not the night's scheduled setting, so it must
          // not be reported as one — it is shown on the timeline instead.
          row.manualOverride = true;
        } else if (event.level != null) {
          // First scheduled value wins: later ones for the same stage are
          // re-sends of the same setting within the 15-minute window.
          const stage = event.stage === "pre-heating" ? "initial" : event.stage;
          if (
            (stage === "initial" || stage === "deep" || stage === "mid" || stage === "final") &&
            row[stage] == null
          ) {
            row[stage] = event.level;
          }
        }
        byNight.set(event.night, row);
      }

      for (const rec of recommendations) {
        const row = byNight.get(rec.forDate);
        const applied = rec.status === "applied" || rec.status === "auto_applied";
        const changed =
          applied &&
          (rec.previousInitialLevel !== rec.recommendedInitialLevel ||
            (rec.previousDeepLevel ?? rec.previousMidLevel) !==
              (rec.recommendedDeepLevel ?? rec.recommendedMidLevel) ||
            rec.previousMidLevel !== rec.recommendedMidLevel ||
            rec.previousFinalLevel !== rec.recommendedFinalLevel);
        if (row) {
          row.aiChanged = changed;
          row.aiStatus = rec.status;
        } else if (rec.forDate === todayKey) {
          byNight.set(rec.forDate, {
            night: rec.forDate,
            initial: null,
            deep: null,
            mid: null,
            final: null,
            aiChanged: changed,
            aiStatus: rec.status,
            liveNudges: 0,
            manualOverride: false,
          });
        }
      }

      // Tonight has not run yet, so its row is the loaded profile rather than
      // anything the pod has been told.
      const todayRow = byNight.get(todayKey);
      byNight.set(todayKey, {
        night: todayKey,
        ...tonight,
        aiChanged: todayRow?.aiChanged ?? false,
        aiStatus: todayRow?.aiStatus ?? null,
        liveNudges: 0,
        manualOverride: todayRow?.manualOverride ?? false,
      });

      const history = [...byNight.values()]
        .filter((row) => row.night <= todayKey)
        .sort((a, b) => a.night.localeCompare(b.night))
        .slice(-(days + 1));

      const lastNightRow = history.find(
        (row) => row.night === shiftDate(todayKey, -1),
      );
      const lastNight =
        lastNightRow &&
        (lastNightRow.initial != null ||
          lastNightRow.deep != null ||
          lastNightRow.mid != null ||
          lastNightRow.final != null)
          ? {
              night: lastNightRow.night,
              initial: lastNightRow.initial,
              deep: lastNightRow.deep,
              mid: lastNightRow.mid,
              final: lastNightRow.final,
            }
          : null;

      const latest = recommendations[recommendations.length - 1];
      const proposed =
        latest && latest.status === "pending"
          ? {
              initial: latest.recommendedInitialLevel,
              deep: latest.recommendedDeepLevel ?? latest.recommendedMidLevel,
              mid: latest.recommendedMidLevel,
              final: latest.recommendedFinalLevel,
            }
          : null;

      // What the loop has learned, so the app and the advisor can never tell
      // different stories about what has been tried.
      let ledger: Awaited<ReturnType<typeof readLedgerForApp>> = {
        ledger: [],
        pressure: [],
      };
      try {
        ledger = await readLedgerForApp(decoded.email, tonight);
      } catch (error) {
        console.error("Ledger read failed:", error);
      }

      return {
        timezone,
        bedTime: profile.bedTime.slice(0, 5),
        wakeupTime: profile.wakeupTime.slice(0, 5),
        todayKey,
        experiments: ledger.ledger,
        livePressure: ledger.pressure,
        tonight,
        lastNight,
        proposed,
        latest: latest
          ? {
              id: latest.id,
              forDate: latest.forDate,
              status: latest.status,
              confidence: latest.confidence,
              updatedAt: latest.updatedAt,
            }
          : null,
        /** Whether today's assessment has happened at all. */
        assessedToday: recommendations.some((r) => r.forDate === todayKey),
        history,
      };
    }),

  // How last night felt, asked once each morning. The only direct reading of
  // comfort the loop ever gets; everything else is inferred from tossing.
  getSleepFeedback: publicProcedure.query(async ({ ctx }) => {
    const decoded = await checkAuthCookie(ctx.headers);
    const profile = await db.query.userTemperatureProfile.findFirst({
      where: eq(userTemperatureProfile.email, decoded.email),
    });
    const timezone = profile?.timezoneTZ ?? "UTC";
    const todayKey = new Date().toLocaleDateString("en-CA", {
      timeZone: timezone,
    });

    const rows = await db
      .select()
      .from(sleepFeedback)
      .where(eq(sleepFeedback.email, decoded.email))
      .orderBy(desc(sleepFeedback.id))
      .limit(14);

    // Only ask about a night the pod actually recorded, and only after the
    // wake-up time has passed — nobody can answer at 03:00.
    const sinceWake = profile
      ? minutesSinceTimeOfDay(
          new Date(),
          timezone,
          profile.wakeupTime.slice(0, 5),
        )
      : NaN;
    const recorded = await readNightMetrics(decoded.email, todayKey, todayKey);

    return {
      night: todayKey,
      answered: rows.some((row) => row.night === todayKey),
      askable: !isNaN(sinceWake) && sinceWake > 0 && recorded.length > 0,
      recent: rows.map((row) => ({
        night: row.night,
        felt: row.felt,
        whenFelt: row.whenFelt,
        note: row.note,
      })),
    };
  }),

  submitSleepFeedback: publicProcedure
    .input(
      z.object({
        night: z.string().max(10),
        felt: z.enum(["too_hot", "too_cold", "just_right"]),
        whenFelt: z
          .enum([
            "falling_asleep",
            "middle",
            "morning",
            "all_night",
            "not_sure",
          ])
          .nullable(),
        note: z.string().max(300).nullable(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const decoded = await checkAuthCookie(ctx.headers);
      // One answer per night; answering again replaces it rather than
      // stacking two contradictory readings.
      await db
        .delete(sleepFeedback)
        .where(
          and(
            eq(sleepFeedback.email, decoded.email),
            eq(sleepFeedback.night, input.night),
          ),
        );
      await db.insert(sleepFeedback).values({
        email: decoded.email,
        night: input.night,
        felt: input.felt,
        whenFelt: input.whenFelt,
        note: input.note,
      });

      // Answering has to change something TODAY. Without this the report sat
      // unused until tomorrow morning's pass, so telling the app "I slept too
      // hot" visibly did nothing to tonight — which reads exactly like not
      // being listened to.
      let reassessed = false;
      try {
        if (input.felt !== "just_right") {
          await reassessToday(decoded.email);
          reassessed = true;
        }
      } catch (error) {
        console.error(
          "Reassessment after feedback failed:",
          error instanceof Error ? error.message : String(error),
        );
      }
      return { success: true, reassessed };
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

  // Recent recommendations, each carrying its structured rationale and — for
  // the ones that actually ran — what happened to the score afterwards, so a
  // prediction can be checked rather than just believed.
  getAiRecommendations: publicProcedure.query(async ({ ctx }) => {
    const decoded = await checkAuthCookie(ctx.headers);
    const rows = await db
      .select()
      .from(aiRecommendations)
      .where(eq(aiRecommendations.email, decoded.email))
      .orderBy(desc(aiRecommendations.id))
      .limit(8);
    if (rows.length === 0) return [];

    // `forDate` is the day the assessment ran, so it governs the night that
    // BEGINS that evening — the night you wake from on forDate + 1.
    const oldest = rows[rows.length - 1]!.forDate;
    const metrics = await readNightMetrics(
      decoded.email,
      shiftDate(oldest, -1),
      shiftDate(rows[0]!.forDate, 2),
    );
    const scoreFor = (night: string) =>
      metrics.find((m) => m.night === night)?.score ?? null;

    return rows.map((row) => {
      let rationale: RecommendationRationale | null = null;
      if (row.rationaleJson) {
        try {
          rationale = JSON.parse(row.rationaleJson) as RecommendationRationale;
        } catch {
          rationale = null;
        }
      }
      const ran = row.status === "applied" || row.status === "auto_applied";
      const before = scoreFor(row.forDate);
      const after = scoreFor(shiftDate(row.forDate, 1));
      return {
        ...row,
        rationale,
        outcome:
          ran && before != null && after != null
            ? { before, after, delta: after - before }
            : null,
      };
    });
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
