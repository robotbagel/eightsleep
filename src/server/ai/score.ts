// score.ts
// One sleep-score rubric shared by every data source (Eight Sleep pod
// sessions and Apple Health imports), so scores are comparable across nights
// regardless of where the night came from. Mirrors the Apple Watch Sleep
// Score weighting: Duration 50 / Bedtime consistency 30 / Interruptions 20.
export interface ScoreInput {
  asleepHours: number;
  awakeHours: number | null;
  wakeCount: number | null;
  // Local minutes-of-day the sleeper fell asleep, and the reference bedtime
  // to compare against (circular mean of recent nights). Null = neutral.
  bedtimeMinutes: number | null;
  referenceBedtimeMinutes: number | null;
}

export const DURATION_TARGET_HOURS = 8.5;

export function scoreNight(input: ScoreInput): number {
  const duration = 50 * Math.min(input.asleepHours / DURATION_TARGET_HOURS, 1);

  let bedtime = 24; // neutral until a reference exists
  if (input.bedtimeMinutes != null && input.referenceBedtimeMinutes != null) {
    let dev = Math.abs(input.bedtimeMinutes - input.referenceBedtimeMinutes);
    if (dev > 12 * 60) dev = 24 * 60 - dev; // wrap around midnight
    bedtime = Math.max(30 - dev / 6, 0);
  }

  const interruptions =
    input.wakeCount != null
      ? Math.max(20 - input.wakeCount - 5 * (input.awakeHours ?? 0), 0)
      : 14;

  return Math.round(duration + bedtime + interruptions);
}

// Circular mean of clock times (handles the midnight wrap), in minutes of day.
export function circularMeanMinutes(values: number[]): number | null {
  if (values.length === 0) return null;
  let sx = 0;
  let sy = 0;
  for (const minutes of values) {
    const angle = (minutes / 1440) * 2 * Math.PI;
    sx += Math.cos(angle);
    sy += Math.sin(angle);
  }
  let mean = (Math.atan2(sy, sx) / (2 * Math.PI)) * 1440;
  if (mean < 0) mean += 1440;
  return mean;
}

export function minutesOfDayInZone(date: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return hour * 60 + minute;
}
