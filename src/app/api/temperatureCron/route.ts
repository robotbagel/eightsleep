import type { NextRequest } from "next/server";
import { db } from "~/server/db";
import { userTemperatureProfile, users } from "~/server/db/schema";
import { eq } from "drizzle-orm";
import { obtainFreshAccessToken } from "~/server/eight/auth";
import { type Token } from "~/server/eight/types";
import { setHeatingLevel, turnOnSide, turnOffSide } from "~/server/eight/eight";
import { getCurrentHeatingStatus } from "~/server/eight/user";
import { recordCronHeartbeat, runDailyAiPass } from "~/server/ai/advisor";
import {
  applyOffsetToLevel,
  getActiveLiveOffset,
  runLiveTuningPass,
} from "~/server/ai/liveTuner";
import { temperatureEvents, userAiSettings } from "~/server/db/schema";
import { detectManualOverride } from "~/server/ai/override";
import { nightKeyFor } from "~/server/ai/time";

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
          // top of the scheduled level so this cron doesn't undo live nudges.
          if (!testMode?.enabled) {
            try {
              const aiSettings = await db.query.userAiSettings.findFirst({
                where: eq(userAiSettings.email, profile.users.email),
              });
              // BEFORE deciding what to write: did a person move it? The old
              // code compared the pod against our target and corrected the
              // difference, which meant someone waking up cold and turning
              // the bed up had it silently undone within ten minutes. A hand
              // on the dial is the strongest signal this system gets.
              let offset = await getActiveLiveOffset(
                profile.users.email,
                userTemperatureProfile.timezoneTZ,
                userTemperatureProfile.wakeupTime.slice(0, 5),
                now,
              );
              const override = await detectManualOverride({
                email: profile.users.email,
                timezone: userTemperatureProfile.timezoneTZ,
                wakeupTime: userTemperatureProfile.wakeupTime.slice(0, 5),
                now,
                stage: sleepStage,
                observedLevel: heatingStatus.heatingLevel,
                currentOffsetTenthsC: offset,
              });
              if (override) {
                offset = override.newOffsetTenthsC;
                console.log(
                  `Manual override by ${profile.users.email}: ${override.deltaTenthsC / 10}°C ${override.direction}; following it for the rest of the night.`,
                );
              }
              if (aiSettings?.liveTuningEnabled || override) {
                if (offset !== 0) {
                  targetLevel = applyOffsetToLevel(targetLevel, offset);
                  console.log(
                    `Applying live tuning offset of ${offset / 10}°C for user ${profile.users.email}; target level now ${targetLevel}`,
                  );
                }
              }
            } catch (error) {
              console.error(
                `Failed to apply live tuning offset for user ${profile.users.email}:`,
                error instanceof Error ? error.message : String(error),
              );
            }
          }

          if (!heatingStatus.isHeating) {
            if (testMode?.enabled) {
              console.log(`[TEST MODE] Would turn on heating for user ${profile.users.email}`);
            } else {
              await retryApiCall(() => turnOnSide(token, profile.users.eightUserId));
              console.log(`Heating turned on for user ${profile.users.email}`);
            }
          }
          if (heatingStatus.heatingLevel !== targetLevel) {
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