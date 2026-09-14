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
import { readNightMetrics, shiftDate } from "~/server/ai/history";
import { activeGuestProfile, guestProfileFor, saveGuestProfile } from "~/server/ai/shareLinks";
import { adjustTemperature } from "~/app/api/temperatureCron/route";

/** One night, read the way the owner reads their own. */
export interface NightReading {
  night: string;
  score: number | null;
  quality: number | null;
  asleepHours: number | null;
  deepHours: number | null;
  remHours: number | null;
  lightHours: number | null;
  awakeHours: number | null;
  latencyMinutes: number | null;
  tosses: number | null;
  wakeCount: number | null;
  restingHeartRate: number | null;
  hrv: number | null;
  respiratoryRate: number | null;
  avgBedTempC: number | null;
  avgRoomTempC: number | null;
  bedtimeMinutes: number | null;
  wakeMinutes: number | null;
}

/** Midnight of the link's creation day, so its first night counts. */
function startOfDay(at: Date): Date {
  const d = new Date(at);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}
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

    // A guest's own stages if they have set them, otherwise the owner's as
    // a starting point.
    const stay = share.capabilities.setStayProfile
      ? await guestProfileFor(share.id)
      : null;
    const schedule = stay ?? profile;

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
      bedTime: schedule.bedTime.slice(0, 5),
      wakeupTime: schedule.wakeupTime.slice(0, 5),
      timezone: profile.timezoneTZ,
      // The four stages this link controls, in °C. For a guest these are
      // their own if they have saved any, otherwise the owner's as a sane
      // starting point — never an arbitrary default they have to fix.
      stages: {
        initial: rawToCelsius(schedule.initialSleepLevel),
        // The owner's deep level is nullable on rows written before the
        // four-stage model; it falls back to mid, exactly as the cron does.
        deep: rawToCelsius(schedule.deepSleepLevel ?? schedule.midStageSleepLevel),
        mid: rawToCelsius(schedule.midStageSleepLevel),
        final: rawToCelsius(schedule.finalSleepLevel),
      },
      hasOwnSchedule: stay != null,
      currentC,
      isHeating,
      minC: MIN_BED_TEMP_C,
      maxC: MAX_BED_TEMP_C,
    };
  }),

  /**
   * Save all four stages and the times for the length of the stay. A guest
   * writes an overlay; a household link writes its own account's real row,
   * because that side is theirs.
   */
  setStages: publicProcedure
    .input(
      tokenInput.extend({
        bedTime: z.string().regex(/^\d{2}:\d{2}$/),
        wakeupTime: z.string().regex(/^\d{2}:\d{2}$/),
        initial: z.number().min(MIN_BED_TEMP_C).max(MAX_BED_TEMP_C),
        deep: z.number().min(MIN_BED_TEMP_C).max(MAX_BED_TEMP_C),
        mid: z.number().min(MIN_BED_TEMP_C).max(MAX_BED_TEMP_C),
        final: z.number().min(MIN_BED_TEMP_C).max(MAX_BED_TEMP_C),
      }),
    )
    .mutation(async ({ input }) => {
      const share = await session(input.token);
      if (!share.capabilities.setStayProfile && !share.capabilities.editOwnerSchedule) {
        throw new TRPCError({ code: "FORBIDDEN", message: "This link does not allow that." });
      }
      const levels = {
        bedTime: `${input.bedTime}:00`,
        wakeupTime: `${input.wakeupTime}:00`,
        initialSleepLevel: celsiusToRaw(input.initial),
        deepSleepLevel: celsiusToRaw(input.deep),
        midStageSleepLevel: celsiusToRaw(input.mid),
        finalSleepLevel: celsiusToRaw(input.final),
      };

      if (share.capabilities.editOwnerSchedule) {
        await db
          .update(userTemperatureProfile)
          .set({ ...levels, updatedAt: new Date() })
          .where(eq(userTemperatureProfile.email, share.email));
      } else {
        // NEVER the owner's row: their profile is what the autopilot has
        // spent weeks tuning, and a visitor's taste must not outlive them.
        await saveGuestProfile(share.id, share.email, levels);
      }

      // Take effect now rather than at the next stage boundary, so a guest
      // who sets this up at 16:00 sees the bed behave before bedtime.
      try {
        await adjustTemperature();
      } catch (error) {
        console.error(
          "Share: could not apply the new schedule immediately:",
          error instanceof Error ? error.message : String(error),
        );
      }
      return { success: true };
    }),

  /**
   * The nights THIS link slept, read exactly the way the owner reads theirs.
   *
   * Scoped in the query, not in the UI: a guest sees only nights recorded as
   * not the owner's, and only from the day their link was made. The owner's
   * own nights can never appear here however this is called.
   */
  nights: publicProcedure.input(tokenInput).query(async ({ input }) => {
    const share = await session(input.token);
    if (!share.capabilities.seeOwnNights) return { nights: [] as NightReading[] };

    const profile = await db.query.userTemperatureProfile.findFirst({
      where: eq(userTemperatureProfile.email, share.email),
    });
    const timezone = profile?.timezoneTZ ?? "UTC";
    const today = new Date().toLocaleDateString("en-CA", { timeZone: timezone });
    const from = shiftDate(today, -30);
    const all = await readNightMetrics(share.email, from, today, timezone);

    const mine = share.capabilities.seeOwnerHistory
      ? all
      : all.filter(
          (night) =>
            night.notMe === true &&
            // Only nights from this stay, never an earlier visitor's.
            new Date(`${night.night}T12:00:00Z`) >= startOfDay(share.createdAt),
        );

    return {
      nights: mine
        .slice()
        .reverse()
        .map(
          (m): NightReading => ({
            night: m.night,
            score: m.score,
            quality: m.thermalScore,
            asleepHours: m.asleepHours,
            deepHours: m.deepHours,
            remHours: m.remHours,
            lightHours: m.lightHours,
            awakeHours: m.awakeHours,
            latencyMinutes:
              m.sleepLatencyHours == null
                ? null
                : Math.round(m.sleepLatencyHours * 60),
            tosses: m.tosses,
            wakeCount: m.wakeCount,
            restingHeartRate: m.restingHeartRate,
            hrv: m.hrv,
            respiratoryRate: m.respiratoryRate,
            avgBedTempC: m.avgBedTempC,
            avgRoomTempC: m.avgRoomTempC,
            bedtimeMinutes: m.bedtimeMinutes,
            wakeMinutes: m.wakeMinutes,
          }),
        ),
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
