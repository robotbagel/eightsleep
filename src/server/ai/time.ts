// time.ts
// Shared helpers for reasoning about the user's sleep cycle in their own
// timezone. All inputs are "HH:MM" strings from the temperature profile.

export function userLocalNow(now: Date, timezone: string): Date {
  return new Date(now.toLocaleString("en-US", { timeZone: timezone }));
}

function parseTime(timeStr: string): { hours: number; minutes: number } | null {
  const [hours, minutes] = timeStr.split(":").map(Number);
  if (
    hours === undefined ||
    minutes === undefined ||
    isNaN(hours) ||
    isNaN(minutes)
  ) {
    return null;
  }
  return { hours, minutes };
}

// Minutes since the given local time-of-day today; negative when it is still
// ahead of the user's local clock. NaN on malformed input.
export function minutesSinceTimeOfDay(
  now: Date,
  timezone: string,
  timeStr: string,
): number {
  const parsed = parseTime(timeStr);
  if (!parsed) return NaN;
  const localNow = userLocalNow(now, timezone);
  const target = new Date(localNow);
  target.setHours(parsed.hours, parsed.minutes, 0, 0);
  return (localNow.getTime() - target.getTime()) / (60 * 1000);
}

// The date key (YYYY-MM-DD, user-local) of the evening the current sleep
// cycle started: before today's wake-up time the night began yesterday.
export function nightKeyFor(
  now: Date,
  timezone: string,
  wakeupTime: string,
): string {
  const sinceWakeup = minutesSinceTimeOfDay(now, timezone, wakeupTime);
  const reference =
    !isNaN(sinceWakeup) && sinceWakeup < 0
      ? new Date(now.getTime() - 24 * 60 * 60 * 1000)
      : now;
  return reference.toLocaleDateString("en-CA", { timeZone: timezone });
}

// Which temperature stage the user is in right now, mirroring the stage
// boundaries the temperature cron uses; null outside the sleep cycle.
// Stages: initial (bed→+1h), deep (+1h→+3h, clamped to the final-stage
// start for short nights), mid, final (last 2h).
export type SleepStage = "initial" | "deep" | "mid" | "final";

export function currentStageFor(
  now: Date,
  timezone: string,
  bedTime: string,
  wakeupTime: string,
): SleepStage | null {
  const sinceBed = minutesSinceTimeOfDay(now, timezone, bedTime);
  const sinceWake = minutesSinceTimeOfDay(now, timezone, wakeupTime);
  if (isNaN(sinceBed) || isNaN(sinceWake)) return null;

  const minutesInDay = 24 * 60;
  const elapsed = ((sinceBed % minutesInDay) + minutesInDay) % minutesInDay;
  const duration =
    (((sinceBed - sinceWake) % minutesInDay) + minutesInDay) % minutesInDay;
  if (duration === 0 || elapsed >= duration) return null;

  if (elapsed >= duration - 120) return "final";
  if (elapsed < 60) return "initial";
  if (elapsed < Math.min(180, duration - 120)) return "deep";
  return "mid";
}
