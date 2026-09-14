// share.ts
// The API a share link talks to.
//
// Every procedure here is authenticated by the link secret itself, never by
// the owner's cookie, and every one of them checks the capability it needs
// before acting. The capability table is the single place that says what a
// role may do (see shareLinks.ts); nothing here decides that for itself.

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { createTRPCRouter, publicProcedure } from "~/server/api/trpc";
import { db } from "~/server/db";
import {
  nightMetrics,
  sleepFeedback,
  userTemperatureProfile,
  users,
} from "~/server/db/schema";
import {
  resolveShareLink,
  type Capabilities,
  type ShareSession,
} from "~/server/ai/shareLinks";
import { getFreshToken } from "~/server/ai/advisor";
import { setHeatingLevel } from "~/server/eight/eight";
import { getCurrentHeatingStatus } from "~/server/eight/user";
import {
  celsiusToRaw,
  MAX_BED_TEMP_C,
  MIN_BED_TEMP_C,
  rawToCelsius,
} from "~/lib/temperature";
import { nightKeyFor } from "~/server/ai/time";
import { logTemperatureEvent } from "~/app/api/temperatureCron/route";

async function session(token: string): Promise<ShareSession> {
  const found = await resolveShareLink(token);
  if (!found) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      // Deliberately one message for unknown, revoked and expired alike.
      message: "This link is no longer valid. Ask for a new one.",
    });
  }
  return found;
}

function require_(capabilities: Capabilities, key: keyof Capabilities): void {
  if (!capabilities[key]) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "This link does not allow that.",
    });
  }
}

const tokenInput = z.object({ token: z.string().min(16).max(128) });

export const shareRouter = createTRPCRouter({
  /** What the link holder is allowed to see and do, plus the bed right now. */
  view: publicProcedure.input(tokenInput).query(async ({ input }) => {
    const share = await session(input.token);
    const [user, profile] = await Promise.all([
      db.query.users.findFirst({ where: eq(users.email, share.email) }),
      db.query.userTemperatureProfile.findFirst({
        where: eq(userTemperatureProfile.email, share.email),
      }),
    ]);
    if (!user || !profile) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "That bed is not set up yet.",
      });
    }

    let currentC: number | null = null;
    let isHeating = false;
    try {
      const status = await getCurrentHeatingStatus(await getFreshToken(user));
      isHeating = status.isHeating;
      currentC =
        status.targetHeatingLevel != null
          ? rawToCelsius(status.targetHeatingLevel)
          : null;
    } catch (error) {
      console.error(
        "Share view: could not read the bed:",
        error instanceof Error ? error.message : String(error),
      );
    }

    return {
      role: share.role,
      label: share.label,
      capabilities: share.capabilities,
      expiresAt: share.expiresAt,
      bedTime: profile.bedTime.slice(0, 5),
      wakeupTime: profile.wakeupTime.slice(0, 5),
      timezone: profile.timezoneTZ,
      currentC,
      isHeating,
      minC: MIN_BED_TEMP_C,
      maxC: MAX_BED_TEMP_C,
    };
  }),

  /**
   * Set the bed temperature now. This writes to the pod directly rather than
   * to the stored schedule: a guest is changing tonight, not redefining how
   * the bed behaves from now on.
   */
  setTemperature: publicProcedure
    .input(tokenInput.extend({ celsius: z.number().min(MIN_BED_TEMP_C).max(MAX_BED_TEMP_C) }))
    .mutation(async ({ input }) => {
      const share = await session(input.token);
      require_(share.capabilities, "setTemperature");
      const user = await db.query.users.findFirst({
        where: eq(users.email, share.email),
      });
      const profile = await db.query.userTemperatureProfile.findFirst({
        where: eq(userTemperatureProfile.email, share.email),
      });
      if (!user || !profile) {
        throw new TRPCError({ code: "NOT_FOUND", message: "That bed is not set up yet." });
      }

      const raw = celsiusToRaw(input.celsius);
      await setHeatingLevel(await getFreshToken(user), user.eightUserId, raw);

      // Logged like any other change so the night's trail stays complete and
      // the override detector does not later read this as a phantom.
      await logTemperatureEvent(
        share.email,
        profile.timezoneTZ,
        profile.wakeupTime.slice(0, 5),
        new Date(),
        "manual",
        raw,
        "manual",
        `Set to ${input.celsius.toFixed(1)}°C from a ${share.role} link${share.label ? ` (${share.label})` : ""}.`,
      );

      // A guest driving the bed is the plainest possible statement that this
      // night is not the owner's. Recorded as a fact, not an inference, so
      // the loop never has to guess at it afterwards.
      if (!share.capabilities.nightsAreTheOwners) {
        const night = nightKeyFor(
          new Date(),
          profile.timezoneTZ,
          profile.wakeupTime.slice(0, 5),
        );
        // The wake date is the night key plus one: the night beginning
        // tonight is the one woken from tomorrow.
        const wake = new Date(`${night}T12:00:00Z`);
        wake.setUTCDate(wake.getUTCDate() + 1);
        const wakeKey = wake.toISOString().slice(0, 10);
        try {
          await db
            .insert(nightMetrics)
            .values({
              email: share.email,
              night: wakeKey,
              source: "pod",
              notMe: true,
              identityConfirmed: true,
              identityReason: `A guest link${share.label ? ` (${share.label})` : ""} controlled the bed this night.`,
            })
            .onConflictDoNothing();
          await db
            .update(nightMetrics)
            .set({
              notMe: true,
              identityConfirmed: true,
              identityReason: `A guest link${share.label ? ` (${share.label})` : ""} controlled the bed this night.`,
            })
            .where(
              and(
                eq(nightMetrics.email, share.email),
                eq(nightMetrics.night, wakeKey),
              ),
            );
        } catch (error) {
          console.error(
            "Share: could not mark the night as a guest's:",
            error instanceof Error ? error.message : String(error),
          );
        }
      }

      return { success: true, celsius: input.celsius };
    }),

  /** How the bed feels. For a household link this steers their own loop. */
  comfort: publicProcedure
    .input(
      tokenInput.extend({
        felt: z.enum(["too_hot", "too_cold", "just_right"]),
        whenFelt: z
          .enum(["falling_asleep", "middle", "morning", "all_night", "not_sure"])
          .nullable(),
      }),
    )
    .mutation(async ({ input }) => {
      const share = await session(input.token);
      require_(share.capabilities, "giveComfortFeedback");
      const profile = await db.query.userTemperatureProfile.findFirst({
        where: eq(userTemperatureProfile.email, share.email),
      });
      if (!profile) {
        throw new TRPCError({ code: "NOT_FOUND", message: "That bed is not set up yet." });
      }
      const night = nightKeyFor(
        new Date(),
        profile.timezoneTZ,
        profile.wakeupTime.slice(0, 5),
      );

      // A guest's comfort report is acted on LIVE — it is why they were given
      // the link — but it is not filed as the owner's evidence, because the
      // loop would then be learning one person's preference from another's
      // body. The temperature change they make is the action; this is the
      // record of why.
      if (!share.capabilities.nightsAreTheOwners) {
        return {
          success: true,
          applied: false,
          message:
            "Noted. Use the warmer and cooler buttons to change the bed itself.",
        };
      }

      await db
        .delete(sleepFeedback)
        .where(
          and(
            eq(sleepFeedback.email, share.email),
            eq(sleepFeedback.night, night),
          ),
        );
      await db.insert(sleepFeedback).values({
        email: share.email,
        night,
        felt: input.felt,
        whenFelt: input.whenFelt,
        note: `Reported from a ${share.role} link${share.label ? ` (${share.label})` : ""}.`,
      });
      return { success: true, applied: true, message: "Thanks — that will steer tonight." };
    }),
});
