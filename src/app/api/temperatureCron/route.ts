import type { NextRequest } from "next/server";
import { db } from "~/server/db";
import { userTemperatureProfile, users } from "~/server/db/schema";
import { eq } from "drizzle-orm";
import { obtainFreshAccessToken } from "~/server/eight/auth";
import { type Token } from "~/server/eight/types";
import { setHeatingLevel, turnOnSide, turnOffSide } from "~/server/eight/eight";
import {
  getCurrentHeatingStatus,
  getGhostSchedules,
  type GhostSchedule,
} from "~/server/eight/user";
import { recordCronHeartbeat, runDailyAiPass } from "~/server/ai/advisor";
import {
  applyOffsetToLevel,
  getActiveLiveOffset,
  runLiveTuningPass,
} from "~/server/ai/liveTuner";
import { appConfig, temperatureEvents } from "~/server/db/schema";
import { detectManualOverride, matchGhostSchedule } from "~/server/ai/override";
import { nightKeyFor } from "~/server/ai/time";
import { sql } from "drizzle-orm";
import { rawToCelsius } from "~/lib/temperature";

// Two schedulers call this route (the NAS timer every 10 minutes and the Mac
// fallback every 30) and land on the same second at :00 and :30. Both used to
// run the full pipeline concurrently, which double-recorded manual overrides
// (two identical rows at 2026-08-29T23:00:03.777/.796) and double-applied
// live nudges (05:00:05.822/06.389). Winner-takes-all: one atomic upsert that
// only succeeds when the previous holder is older than 60 seconds, so a dead
// primary never blocks the fallback. Pool-safe on purpose — an advisory lock
// leaks with pooled serverless connections, a row compare-and-set cannot.
async function winTickGate(now: Date): Promise<boolean> {
  try {
    const cutoff = new Date(now.getTime() - 60_000).toISOString();
    const result = await db.execute(
      sql`insert into ${appConfig} ("key", "value")
          values ('cron:tickGate', ${now.toISOString()})
          on conflict ("key") do update set "value" = excluded."value"
          where ${appConfig.value} < ${cutoff}
          returning "key"`,
    );
    const rows = (result as unknown as { rows?: unknown[] }).rows;
    return (rows?.length ?? 0) > 0;
  } catch (error) {
    // If the gate itself fails, running the tick is the safer failure mode.
    console.error(
      "Tick gate unavailable, proceeding:",
      error instanceof Error ? error.message : String(error),
    );
    return true;
  }
}

async function logTemperatureEvent(
  email: string,
  timezone: string,
  wakeupTime: string,
  now: Date,
  stage: string,
  level: number | null,
  source: string,
  note?: string,
): Promise<void> {
  try {
    await db.insert(temperatureEvents).values({
      email,
      night: nightKeyFor(now, timezone, wakeupTime),
      at: now,
      stage,
      level,
      source,
      note: note ?? null,
    });
  } catch (error) {
    console.error(
      `Failed to log temperature event for ${email}:`,
      error instanceof Error ? error.message : String(error),
    );
  }
}

export const runtime = "nodejs";

function createDateWithTime(baseDate: Date, timeString: string): Date {
  const [hours, minutes] = timeString.split(':').map(Number);
  if (hours === undefined || minutes === undefined || isNaN(hours) || isNaN(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    throw new Error(`Invalid time string: ${timeString}`);
  }
  const result = new Date(baseDate);
  result.setHours(hours, minutes, 0, 0);
  return result;
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function isWithinTimeRange(current: Date, target: Date, rangeMinutes: number): boolean {
  const diffMs = Math.abs(current.getTime() - target.getTime());
  return diffMs <= rangeMinutes * 60 * 1000;
}


async function retryApiCall<T>(apiCall: () => Promise<T>, retries = 3): Promise<T> {
  for (let i = 0; i < retries; i++) {
    try {
      return await apiCall();
    } catch (error) {
      if (i === retries - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, i)));
    }
  }
  throw new Error("This should never happen due to the for loop, but TypeScript doesn't know that");
}

interface SleepCycle {
  preHeatingTime: Date;
  bedTime: Date;
  deepStageTime: Date;
  deepEndTime: Date;
  finalStageTime: Date;
  wakeupTime: Date;
}

function createSleepCycle(baseDate: Date, bedTimeStr: string, wakeupTimeStr: string): SleepCycle {
  const preHeatingTime = createDateWithTime(baseDate, bedTimeStr);
  preHeatingTime.setHours(preHeatingTime.getHours() - 1); // Set pre-heating to 1 hour before bedtime

  const bedTime = createDateWithTime(baseDate, bedTimeStr);
  let wakeupTime = createDateWithTime(baseDate, wakeupTimeStr);

  // Adjust wakeupTime if it's before bedTime (i.e., it's on the next day)
  if (wakeupTime <= bedTime) {
    wakeupTime = addDays(wakeupTime, 1);
  }

  // Four stages: initial (bed→+1h), deep (+1h→+3h — the cool trough for
  // slow-wave sleep), mid (+3h→wake-2h), final (last 2h). On short nights the
  // deep stage is clamped so it never overlaps the final stage.
  const deepStageTime = new Date(bedTime.getTime() + 60 * 60 * 1000);
  const finalStageTime = new Date(wakeupTime.getTime() - 2 * 60 * 60 * 1000);
  const deepEndTime = new Date(
    Math.min(bedTime.getTime() + 3 * 60 * 60 * 1000, finalStageTime.getTime()),
  );

  return { preHeatingTime, bedTime, deepStageTime, deepEndTime, finalStageTime, wakeupTime };
}

function adjustTimeToCurrentCycle(cycleStart: Date, currentTime: Date, timeInCycle: Date): Date {
  let adjustedTime = new Date(timeInCycle);
  
  // If the time in the cycle is before the cycle start, it means it's on the next day
  if (timeInCycle < cycleStart) {
    adjustedTime = addDays(adjustedTime, 1);
  }
  
  // If the adjusted time is in the future relative to the current time, move it back by one day
  if (adjustedTime > currentTime && adjustedTime.getTime() - currentTime.getTime() > 12 * 60 * 60 * 1000) {
    adjustedTime = addDays(adjustedTime, -1);
  }
  
  return adjustedTime;
}

interface TestMode {
  enabled: boolean;
  currentTime: Date;
}

export async function adjustTemperature(testMode?: TestMode): Promise<void> {
  try {
    const profiles = await db
      .select()
      .from(userTemperatureProfile)
      .innerJoin(users, eq(userTemperatureProfile.email, users.email));

    for (const profile of profiles) {
      try {
        let token: Token = {
          eightAccessToken: profile.users.eightAccessToken,
          eightRefreshToken: profile.users.eightRefreshToken,
          eightExpiresAtPosix: profile.users.eightTokenExpiresAt.getTime(),
          eightUserId: profile.users.eightUserId,
        };

        const now = testMode?.enabled ? testMode.currentTime : new Date();

        if (!testMode?.enabled && now.getTime() > token.eightExpiresAtPosix) {
          token = await obtainFreshAccessToken(
            token.eightRefreshToken,
            token.eightUserId,
          );
          await db
            .update(users)
            .set({
              eightAccessToken: token.eightAccessToken,
              eightRefreshToken: token.eightRefreshToken,
              eightTokenExpiresAt: new Date(token.eightExpiresAtPosix),
            })
            .where(eq(users.email, profile.users.email));
        }

        const userTemperatureProfile = profile.userTemperatureProfiles;
        const userNow = new Date(now.toLocaleString("en-US", { timeZone: userTemperatureProfile.timezoneTZ }));

        // Create the sleep cycle based on the user's bed time and wake-up time
        const sleepCycle = createSleepCycle(userNow, userTemperatureProfile.bedTime, userTemperatureProfile.wakeupTime);

        // Adjust all times in the cycle to the current day
        const cycleStart = sleepCycle.preHeatingTime;
        const adjustedCycle: SleepCycle = {
          preHeatingTime: adjustTimeToCurrentCycle(cycleStart, userNow, sleepCycle.preHeatingTime),
          bedTime: adjustTimeToCurrentCycle(cycleStart, userNow, sleepCycle.bedTime),
          deepStageTime: adjustTimeToCurrentCycle(cycleStart, userNow, sleepCycle.deepStageTime),
          deepEndTime: adjustTimeToCurrentCycle(cycleStart, userNow, sleepCycle.deepEndTime),
          finalStageTime: adjustTimeToCurrentCycle(cycleStart, userNow, sleepCycle.finalStageTime),
          wakeupTime: adjustTimeToCurrentCycle(cycleStart, userNow, sleepCycle.wakeupTime),
        };

        let heatingStatus;
        if (testMode?.enabled) {
          heatingStatus = { isHeating: false, heatingLevel: 0 }; // Mock heating status for test mode
          console.log(`[TEST MODE] Current time set to: ${userNow.toISOString()}`);
        } else {
          heatingStatus = await retryApiCall(() => getCurrentHeatingStatus(token));
        }

        console.log(`Current heating status for user ${profile.users.email}:`, JSON.stringify(heatingStatus));
        console.log(`User's current time: ${userNow.toISOString()} for user ${profile.users.email}`);
        console.log(`Adjusted times for user ${profile.users.email}:`);
        console.log(`Pre-heating: ${adjustedCycle.preHeatingTime.toISOString()}`);
        console.log(`Bed time: ${adjustedCycle.bedTime.toISOString()}`);
        console.log(`Deep stage: ${adjustedCycle.deepStageTime.toISOString()}`);
        console.log(`Deep end / mid stage: ${adjustedCycle.deepEndTime.toISOString()}`);
        console.log(`Final stage: ${adjustedCycle.finalStageTime.toISOString()}`);
        console.log(`Wake-up: ${adjustedCycle.wakeupTime.toISOString()}`);

        // The deep stage falls back to the mid-stage level until the user (or
        // the AI) sets one — rows from before the 4-stage model have null.
        const deepLevel =
          userTemperatureProfile.deepSleepLevel ??
          userTemperatureProfile.midStageSleepLevel;

        const isNearPreHeating = isWithinTimeRange(userNow, adjustedCycle.preHeatingTime, 15);
        const isNearBedTime = isWithinTimeRange(userNow, adjustedCycle.bedTime, 15);
        const isNearDeepStage = isWithinTimeRange(userNow, adjustedCycle.deepStageTime, 15);
        const isNearDeepEnd = isWithinTimeRange(userNow, adjustedCycle.deepEndTime, 15);
        const isNearFinalStage = isWithinTimeRange(userNow, adjustedCycle.finalStageTime, 15);
        const isNearWakeup = isWithinTimeRange(userNow, adjustedCycle.wakeupTime, 15);

        // Determine current sleep stage
        let currentSleepStage = "outside sleep cycle";
        if (userNow >= adjustedCycle.preHeatingTime && userNow < adjustedCycle.bedTime) {
          currentSleepStage = "pre-heating";
        } else if (userNow >= adjustedCycle.bedTime && userNow < adjustedCycle.deepStageTime) {
          currentSleepStage = "initial";
        } else if (userNow >= adjustedCycle.deepStageTime && userNow < adjustedCycle.deepEndTime) {
          currentSleepStage = "deep";
        } else if (userNow >= adjustedCycle.deepEndTime && userNow < adjustedCycle.finalStageTime) {
          currentSleepStage = "mid";
        } else if (userNow >= adjustedCycle.finalStageTime && userNow < adjustedCycle.wakeupTime) {
          currentSleepStage = "final";
        }

        console.log(`Current sleep stage for user ${profile.users.email}: ${currentSleepStage}`);

        // Did a person move the dial? Checked EVERY tick inside the sleep
        // cycle, not only near stage boundaries — a hand adjustment at 01:30
        // in the middle of the long mid stage used to stay invisible for
        // hours, during which a live nudge could silently stomp it.
        //
        // The comparison uses the pod's TARGET level. `heatingLevel` is the
        // current, physically ramping value: after a hard manual cooling the
        // bed lags warm for an hour or more, and comparing that lag against
        // our written setpoint fabricated a "+3.4°C warmer manual override"
        // on 2026-08-30 at 00:40 — the sleeper had only ever cooled. The
        // target only changes when someone (us, the Eight app, anything)
        // actually sets it, which is exactly the signal wanted.
        let liveOffset = 0;
        if (
          !testMode?.enabled &&
          currentSleepStage !== "outside sleep cycle" &&
          heatingStatus.targetHeatingLevel != null
        ) {
          try {
            liveOffset = await getActiveLiveOffset(
              profile.users.email,
              userTemperatureProfile.timezoneTZ,
              userTemperatureProfile.wakeupTime.slice(0, 5),
              now,
            );

            // Eight's cloud carries a leftover schedule the app cannot see
            // (23:00:28, level -40). A target change matching an enabled
            // schedule's level near its firing time is that robot, not a
            // hand on the dial: reassert our own schedule instead of
            // honouring it, and record what happened by name.
            let ghosts: GhostSchedule[] = [];
            try {
              ghosts = await getGhostSchedules(token, profile.users.eightUserId);
            } catch {
              // Unreadable schedules must not stop the override check.
            }
            const ghost = matchGhostSchedule(
              ghosts,
              heatingStatus.targetHeatingLevel,
              userNow,
            );
            if (ghost) {
              const stageLevel =
                currentSleepStage === "deep"
                  ? deepLevel
                  : currentSleepStage === "mid"
                    ? userTemperatureProfile.midStageSleepLevel
                    : currentSleepStage === "final"
                      ? userTemperatureProfile.finalSleepLevel
                      : userTemperatureProfile.initialSleepLevel;
              const reassert = applyOffsetToLevel(stageLevel, liveOffset);
              if (reassert !== heatingStatus.targetHeatingLevel) {
                await retryApiCall(() =>
                  setHeatingLevel(token, profile.users.eightUserId, reassert),
                );
                await logTemperatureEvent(
                  profile.users.email,
                  userTemperatureProfile.timezoneTZ,
                  userTemperatureProfile.wakeupTime.slice(0, 5),
                  now,
                  currentSleepStage,
                  reassert,
                  "scheduled",
                  `Reasserted the schedule over Eight's leftover ${ghost.time.slice(0, 5)} cloud schedule — not a hand adjustment.`,
                );
                console.log(
                  `Ghost schedule (${ghost.time}, level ${ghost.level}) reverted for ${profile.users.email}.`,
                );
              }
            } else {
            const override = await detectManualOverride({
              email: profile.users.email,
              timezone: userTemperatureProfile.timezoneTZ,
              wakeupTime: userTemperatureProfile.wakeupTime.slice(0, 5),
              now,
              stage: currentSleepStage,
              observedLevel: heatingStatus.targetHeatingLevel,
              currentOffsetTenthsC: liveOffset,
            });
            if (override) {
              liveOffset = override.newOffsetTenthsC;
              console.log(
                `Manual override by ${profile.users.email}: ${override.deltaTenthsC / 10}°C ${override.direction}; following it for the rest of the night.`,
              );
            }
            }
          } catch (error) {
            console.error(
              `Manual-override check failed for user ${profile.users.email}:`,
              error instanceof Error ? error.message : String(error),
            );
          }
        }

        if (isNearPreHeating || isNearBedTime || isNearDeepStage || isNearDeepEnd || isNearFinalStage || isNearWakeup) {
          let targetLevel: number;
          let sleepStage: string;

          if (isNearPreHeating || (isNearBedTime && userNow < adjustedCycle.bedTime)) {
            targetLevel = userTemperatureProfile.initialSleepLevel;
            sleepStage = "pre-heating";
          } else if (isNearBedTime || (isNearDeepStage && userNow < adjustedCycle.deepStageTime)) {
            targetLevel = userTemperatureProfile.initialSleepLevel;
            sleepStage = "initial";
          } else if (isNearDeepStage || (isNearDeepEnd && userNow < adjustedCycle.deepEndTime)) {
            targetLevel = deepLevel;
            sleepStage = "deep";
          } else if (
            // On short nights deepEnd is clamped onto the final-stage start;
            // the final stage must win that shared boundary.
            (isNearDeepEnd &&
              adjustedCycle.deepEndTime < adjustedCycle.finalStageTime) ||
            (isNearFinalStage && userNow < adjustedCycle.finalStageTime)
          ) {
            targetLevel = userTemperatureProfile.midStageSleepLevel;
            sleepStage = "mid";
          } else {
            targetLevel = userTemperatureProfile.finalSleepLevel;
            sleepStage = "final";
          }

          console.log(`Adjusting temperature for ${sleepStage} stage for user ${profile.users.email}`);

          // Live tuning stores an in-night offset (tenths of °C); apply it on
          // top of the scheduled level so this cron doesn't undo live nudges
          // — and doesn't undo a hand on the dial, which the check above has
          // already folded into the offset.
          if (!testMode?.enabled && liveOffset !== 0) {
            targetLevel = applyOffsetToLevel(targetLevel, liveOffset);
            console.log(
              `Applying live offset of ${liveOffset / 10}°C for user ${profile.users.email}; target level now ${targetLevel}`,
            );
          }

          if (!heatingStatus.isHeating) {
            if (testMode?.enabled) {
              console.log(`[TEST MODE] Would turn on heating for user ${profile.users.email}`);
            } else {
              await retryApiCall(() => turnOnSide(token, profile.users.eightUserId));
              console.log(`Heating turned on for user ${profile.users.email}`);
            }
          }
          // Compare the pod's TARGET, not its ramping current level — the
          // ramp made this true on nearly every boundary tick (16-23
          // "scheduled" writes a night, all re-sending the same setpoint).
          // With the same tolerance the override detector uses: the device
          // reports its target with ±1-level jitter (read 6 when set 5,
          // observed live 2026-08-30), and an exact-match guard re-sends the
          // same level every tick over a difference no one can feel.
          if (
            Math.abs(
              rawToCelsius(heatingStatus.targetHeatingLevel ?? targetLevel) -
                rawToCelsius(targetLevel),
            ) >= 0.25
          ) {
            if (testMode?.enabled) {
              console.log(`[TEST MODE] Would set heating level to ${targetLevel} for user ${profile.users.email}`);
            } else {
              await retryApiCall(() => setHeatingLevel(token, profile.users.eightUserId, targetLevel));
              console.log(`Heating level set to ${targetLevel} for user ${profile.users.email}`);
              await logTemperatureEvent(
                profile.users.email,
                userTemperatureProfile.timezoneTZ,
                userTemperatureProfile.wakeupTime.slice(0, 5),
                now,
                sleepStage,
                targetLevel,
                "scheduled",
              );
            }
          }
        } else if (heatingStatus.isHeating && userNow > adjustedCycle.wakeupTime && !isWithinTimeRange(userNow, adjustedCycle.wakeupTime, 15)) {
          // Only turn off heating if it's more than 15 minutes past wake-up time
          if (testMode?.enabled) {
            console.log(`[TEST MODE] Would turn off heating for user ${profile.users.email}`);
          } else {
            await retryApiCall(() => turnOffSide(token, profile.users.eightUserId));
            console.log(`Heating turned off for user ${profile.users.email}`);
            await logTemperatureEvent(
              profile.users.email,
              userTemperatureProfile.timezoneTZ,
              userTemperatureProfile.wakeupTime.slice(0, 5),
              now,
              "wake",
              null,
              "off",
              "Heating turned off after wake-up",
            );
          }
        } else {
          console.log(`No temperature change needed for user ${profile.users.email}`);
        }

        console.log(`Successfully completed temperature adjustment check for user ${profile.users.email}`);
      } catch (error) {
        console.error(`Error adjusting temperature for user ${profile.users.email}:`, error instanceof Error ? error.message : String(error));
      }
    }
  } catch (error) {
    console.error("Error fetching user profiles:", error instanceof Error ? error.message : String(error));
    throw error;
  }
}

export async function GET(request: NextRequest): Promise<Response> {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  } else {
    try {
      const testTimeParam = request.nextUrl.searchParams.get("testTime");
      if (testTimeParam) {
        const testTime = new Date(Number(testTimeParam)* 1000);
        if (isNaN(testTime.getTime())) {
          throw new Error("Invalid testTime parameter");
        }
        console.log(`[TEST MODE] Running temperature adjustment cron job with test time: ${testTime.toISOString()}`);
        await adjustTemperature({ enabled: true, currentTime: testTime });
      } else {
        // Every stage is isolated. The temperature adjustment is the critical
        // path, but a failure in it must not take the AI passes down with it:
        // that is how a whole day of recommendations went missing without a
        // single user-visible signal.
        await recordCronHeartbeat(request.nextUrl.searchParams.get("src"));
        // The heartbeat is per-source and must record BEFORE the gate so the
        // monitor still sees both schedulers alive; everything below runs
        // once per minute at most, whoever fires first.
        if (!(await winTickGate(new Date()))) {
          return Response.json({ success: true, skipped: "concurrent tick" });
        }
        try {
          await adjustTemperature();
        } catch (error) {
          console.error(
            "Temperature adjustment failed:",
            error instanceof Error ? error.message : String(error),
          );
        }
        // Live tuning nudges the in-progress night; the daily pass turns the
        // finished night into a recommendation once per day after wake-up.
        try {
          await runLiveTuningPass();
        } catch (error) {
          console.error(
            "AI live tuning pass failed:",
            error instanceof Error ? error.message : String(error),
          );
        }
        try {
          await runDailyAiPass();
        } catch (error) {
          console.error(
            "AI daily pass failed:",
            error instanceof Error ? error.message : String(error),
          );
        }
      }
      return Response.json({ success: true });
    } catch (error) {
      console.error("Error in temperature adjustment cron job:", error instanceof Error ? error.message : String(error));
      return new Response("Internal server error", { status: 500 });
    }
  }
}