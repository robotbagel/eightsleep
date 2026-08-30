// liveTuner.ts
// In-night live tuning. Runs on every 30-minute cron tick during the sleep
// cycle for users who enabled it: reads the last ~45 minutes of the
// in-progress session (tosses, heart rate, bed temperature), applies one
// small research-backed nudge when the data calls for it, and records every
// adjustment so the UI (and the nightly advisor) can see what happened.
//
// The nudge is an OFFSET on top of the scheduled stage temperature, stored in
// tenths of a degree Celsius, capped at ±LIVE_OFFSET_CAP and reset each
// night. The temperature cron adds the active offset to its target so the two
// never fight each other.
import { db } from "~/server/db";
import { sleepFeedback } from "~/server/db/schema";
import {
  aiLiveAdjustments,
  temperatureEvents,
  userAiSettings,
  userTemperatureProfile,
  users,
} from "~/server/db/schema";
import { and, desc, eq } from "drizzle-orm";
import { setHeatingLevel } from "~/server/eight/eight";
import { fetchCurrentSessionWindow } from "./sleepData";
import { computeLiveNudge } from "./rules";
import { getFreshToken } from "./advisor";
import { currentStageFor, nightKeyFor } from "./time";
import {
  celsiusToRaw,
  MAX_BED_TEMP_C,
  MIN_BED_TEMP_C,
  rawToCelsius,
} from "~/lib/temperature";

export async function getActiveLiveOffset(
  email: string,
  timezone: string,
  wakeupTime: string,
  now: Date = new Date(),
): Promise<number> {
  const night = nightKeyFor(now, timezone, wakeupTime);
  const latest = await db.query.aiLiveAdjustments.findFirst({
    where: and(
      eq(aiLiveAdjustments.email, email),
      eq(aiLiveAdjustments.night, night),
    ),
    orderBy: desc(aiLiveAdjustments.id),
  });
  return latest?.newOffset ?? 0;
}

// Applies a tenths-of-°C offset to a raw scheduled level and returns the raw
// level to send to the pod.
export function applyOffsetToLevel(rawLevel: number, offsetTenthsC: number): number {
  const celsius = Math.min(
    Math.max(rawToCelsius(rawLevel) + offsetTenthsC / 10, MIN_BED_TEMP_C),
    MAX_BED_TEMP_C,
  );
  return celsiusToRaw(celsius);
}

export async function runLiveTuningPass(): Promise<void> {
  const rows = await db
    .select()
    .from(userAiSettings)
    .innerJoin(
      userTemperatureProfile,
      eq(userAiSettings.email, userTemperatureProfile.email),
    )
    .innerJoin(users, eq(userAiSettings.email, users.email))
    .where(eq(userAiSettings.liveTuningEnabled, true));

  const now = new Date();
  for (const row of rows) {
    const email = row.userAiSettings.email;
    try {
      const profile = row.userTemperatureProfiles;
      const bedTime = profile.bedTime.slice(0, 5);
      const wakeupTime = profile.wakeupTime.slice(0, 5);
      const stage = currentStageFor(
        now,
        profile.timezoneTZ,
        bedTime,
        wakeupTime,
      );
      if (!stage) continue;

      // What the sleeper said about the last two nights. A person reporting
      // "I woke up cold" is the only direct reading of comfort there is, and
      // it steers tonight's nudges rather than waiting for the morning pass.
      //
      // RECENT nights only: the query used to take the newest two rows with
      // no age limit, so a pair of old "too hot" reports kept driving
      // coolings indefinitely — long after the morning pass had already
      // folded that report into the base profile (double-counting it).
      const todayLocal = now.toLocaleDateString("en-CA", {
        timeZone: row.userTemperatureProfiles.timezoneTZ,
      });
      const cutoffNight = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000)
        .toLocaleDateString("en-CA", {
          timeZone: row.userTemperatureProfiles.timezoneTZ,
        });
      let comfortBias: "cooler" | "warmer" | null = null;
      try {
        const recent = (
          await db
            .select()
            .from(sleepFeedback)
            .where(eq(sleepFeedback.email, email))
            .orderBy(desc(sleepFeedback.night))
            .limit(2)
        ).filter((r) => r.night >= cutoffNight && r.night <= todayLocal);
        const votes = recent
          .map((r) =>
            r.felt === "too_hot"
              ? "cooler"
              : r.felt === "too_cold"
                ? "warmer"
                : null,
          )
          .filter((v): v is "cooler" | "warmer" => v != null);
        if (votes.length > 0 && votes.every((v) => v === votes[0])) {
          comfortBias = votes[0]!;
        }
      } catch (error) {
        console.error(
          `Could not read comfort bias for ${email}:`,
          error instanceof Error ? error.message : String(error),
        );
      }

      const token = await getFreshToken(row.users);
      const window = await fetchCurrentSessionWindow(
        token,
        row.users.eightUserId,
        profile.timezoneTZ,
      );
      if (!window) continue;

      // Plausibility gate: the pod's piezo sensors register any weight on the
      // mattress (a pet on the blanket is enough to show "in use"), so only
      // act when the vitals look like a sleeping adult. Without a credible
      // heart rate we never touch the temperature.
      const humanHeartRate =
        window.nightAvgHeartRate != null &&
        window.nightAvgHeartRate >= 30 &&
        window.nightAvgHeartRate <= 110;
      if (!humanHeartRate) {
        console.log(
          `Live tuning skipped for ${email}: implausible/absent heart rate (${window.nightAvgHeartRate}) — not a sleeping person.`,
        );
        continue;
      }

      const night = nightKeyFor(now, profile.timezoneTZ, wakeupTime);
      const currentOffset = await getActiveLiveOffset(
        email,
        profile.timezoneTZ,
        wakeupTime,
        now,
      );

      // Tonight's adjustment trail, split into what the SLEEPER did (manual
      // overrides, which set direction and must never be fought) and what
      // this tuner did (AI nudges, which set the cooldown clock).
      let overrideTonight: "cooler" | "warmer" | null = null;
      let minutesSinceLastNudge: number | null = null;
      const tonightRows = await db
        .select()
        .from(aiLiveAdjustments)
        .where(
          and(
            eq(aiLiveAdjustments.email, email),
            eq(aiLiveAdjustments.night, night),
          ),
        )
        .orderBy(desc(aiLiveAdjustments.id))
        .limit(20);
      for (const adjustment of tonightRows) {
        const isManual = adjustment.reason.startsWith("Manual override");
        if (isManual && overrideTonight == null) {
          overrideTonight = adjustment.offsetDelta > 0 ? "warmer" : "cooler";
        }
        if (!isManual && minutesSinceLastNudge == null) {
          minutesSinceLastNudge = Math.round(
            (now.getTime() - adjustment.createdAt.getTime()) / 60000,
          );
        }
      }

      // Minutes until the alarm, for the pre-wake quiet period.
      const [wakeH, wakeM] = wakeupTime.split(":").map(Number);
      const nowParts = new Intl.DateTimeFormat("en-GB", {
        timeZone: profile.timezoneTZ,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).formatToParts(now);
      const nowMinutes =
        Number(nowParts.find((p) => p.type === "hour")?.value ?? "0") * 60 +
        Number(nowParts.find((p) => p.type === "minute")?.value ?? "0");
      const minutesToWake =
        ((wakeH ?? 0) * 60 + (wakeM ?? 0) - nowMinutes + 1440) % 1440;

      const nudge = computeLiveNudge({
        recentTosses: window.recentTosses,
        recentAvgHeartRate: window.recentAvgHeartRate,
        nightAvgHeartRate: window.nightAvgHeartRate,
        recentAvgBedTempC: window.recentAvgBedTempC,
        currentStage: stage,
        currentOffset,
        nightAvgBedTempC: window.nightAvgBedTempC,
        comfortBias,
        overrideTonight,
        burstTosses: window.burstTosses,
        nightTossRatePerHour: window.nightTossRatePerHour,
        minutesToWake,
        minutesSinceLastNudge,
      });
      if (!nudge) continue;

      const plannedLevel =
        stage === "initial"
          ? profile.initialSleepLevel
          : stage === "deep"
            ? (profile.deepSleepLevel ?? profile.midStageSleepLevel)
            : stage === "mid"
              ? profile.midStageSleepLevel
              : profile.finalSleepLevel;
      const newOffset = currentOffset + nudge.delta;
      const appliedLevel = applyOffsetToLevel(plannedLevel, newOffset);

      await setHeatingLevel(token, row.users.eightUserId, appliedLevel);
      await db.insert(aiLiveAdjustments).values({
        email,
        night,
        stage,
        offsetDelta: nudge.delta,
        newOffset,
        appliedLevel,
        reason: nudge.reason,
      });
      await db.insert(temperatureEvents).values({
        email,
        night,
        at: now,
        stage,
        level: appliedLevel,
        source: "live",
        note: nudge.reason,
      });
      console.log(
        `Live tuning for ${email}: ${nudge.reason} ${rawToCelsius(plannedLevel)}°C -> ${rawToCelsius(appliedLevel)}°C (offset ${newOffset / 10}°C).`,
      );
    } catch (error) {
      console.error(
        `Live tuning failed for ${email}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}
