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
import {
  aiLiveAdjustments,
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

      const token = await getFreshToken(row.users);
      const window = await fetchCurrentSessionWindow(
        token,
        row.users.eightUserId,
      );
      if (!window) continue;

      const night = nightKeyFor(now, profile.timezoneTZ, wakeupTime);
      const currentOffset = await getActiveLiveOffset(
        email,
        profile.timezoneTZ,
        wakeupTime,
        now,
      );

      const nudge = computeLiveNudge({
        recentTosses: window.recentTosses,
        recentAvgHeartRate: window.recentAvgHeartRate,
        nightAvgHeartRate: window.nightAvgHeartRate,
        recentAvgBedTempC: window.recentAvgBedTempC,
        currentStage: stage,
        currentOffset,
      });
      if (!nudge) continue;

      const plannedLevel =
        stage === "initial"
          ? profile.initialSleepLevel
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
