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

// ---------------------------------------------------------------------------
// Thermal score
//
// The overall sleep score above is a good summary of a NIGHT, but it is the
// wrong thing for a temperature controller to optimise: 50 of its points are
// duration and 30 are bedtime consistency, neither of which a bed can change.
// Measured on this account over 2026-08-23..29 the overall score correlated
// +0.67 with time asleep and −0.38 with deep sleep — so a loop maximising it
// was steering AWAY from deep sleep, and the night with the most deep sleep
// all week scored the worst.
//
// This score uses only what bed temperature plausibly moves: how the night
// divided into stages, how much you thrashed, and how much of the time in bed
// was spent awake. Duration and bedtime are deliberately absent.
// ---------------------------------------------------------------------------

export interface ThermalInput {
  asleepHours: number;
  deepHours: number | null;
  remHours: number | null;
  awakeHours: number | null;
  tosses: number | null;
}

/** Triangular credit: full marks inside [lo, hi], tapering to zero at `fade`. */
function band(value: number, lo: number, hi: number, fade: number): number {
  if (value >= lo && value <= hi) return 1;
  const distance = value < lo ? lo - value : value - hi;
  return Math.max(0, 1 - distance / fade);
}

export function thermalScore(input: ThermalInput): number | null {
  // Too short a night tells you nothing about temperature.
  if (!isFinite(input.asleepHours) || input.asleepHours < 2) return null;
  if (input.deepHours == null && input.remHours == null && input.tosses == null) {
    return null;
  }

  const asleep = input.asleepHours;
  let earned = 0;
  let available = 0;

  // Deep sleep share — the measure most responsive to a cool bed early on.
  if (input.deepHours != null) {
    available += 30;
    earned += 30 * band(input.deepHours / asleep, 0.15, 0.25, 0.12);
  }

  // REM share — protected by gentle warmth in the last hours.
  if (input.remHours != null) {
    available += 25;
    earned += 25 * band(input.remHours / asleep, 0.18, 0.27, 0.14);
  }

  // Restlessness per hour: the most direct "the bed is wrong" signal.
  if (input.tosses != null) {
    available += 25;
    const perHour = input.tosses / asleep;
    earned += 25 * band(perHour, 0, 2.5, 3.5);
  }

  // Time awake in bed, as a share of the night.
  if (input.awakeHours != null) {
    available += 20;
    earned += 20 * band(input.awakeHours / (asleep + input.awakeHours), 0, 0.1, 0.18);
  }

  if (available === 0) return null;
  return Math.round((earned / available) * 100);
}
