// score.ts
// One sleep-score rubric shared by every data source (Eight Sleep pod
// sessions and Apple Health imports), so scores are comparable across nights
// regardless of where the night came from — and comparable with the Apple
// Watch Sleep Score, which is what Nathan reads next to ours.
//
// Weighting follows Apple's published split (Duration 50 / Bedtime
// consistency 30 / Interruptions 20). The shape of each term was fitted on
// 2026-09-05 against five nights where Apple's per-term breakdown was known
// (1–5 Sep 2026) plus the5krunner's reverse-engineering of watchOS 26
// (the5krunner.com, 2025-10-06); the fit hits all five duration and bedtime
// terms exactly and the interruption terms within ±0.5 pt. Before that fit
// the rubric charged 1 pt per wake-up and 5 pts per awake HOUR with no free
// allowance, and the pod's "awake" figure it was fed included the time lying
// in bed BEFORE falling asleep and AFTER waking — so a 54-minute read before
// sleep cost 4.5 points of "interruptions". That is why our scores ran 10–16
// below Apple's for the same nights.
export interface ScoreInput {
  asleepHours: number;
  /**
   * Hours awake AFTER sleep onset and BEFORE the final wake — the clinical
   * WASO. Never the pod's total `awakeDuration`, which also counts time in
   * bed before falling asleep and after waking up; use
   * `awakeAfterOnsetHours()` in sleepData.ts. Null = unknown.
   */
  awakeHours: number | null;
  /** Distinct awakenings inside the sleep window. Null = unknown. */
  wakeCount: number | null;
  // Local minutes-of-day the sleeper fell asleep, and the reference bedtime
  // to compare against (circular mean of recent nights). Null = neutral.
  bedtimeMinutes: number | null;
  referenceBedtimeMinutes: number | null;
}

/** Full duration marks at or above this; Apple deducts below ~7h50m. */
export const DURATION_TARGET_HOURS = 7.67;
/** Points lost per hour short of the target (linear fit, 6–7.5h band). */
export const DURATION_POINTS_PER_HOUR_SHORT = 8.2;
/** Going to bed up to this many minutes late costs nothing. */
export const BEDTIME_LATE_GRACE_MIN = 15;
/** Then one point per this many minutes late (60 min late ≈ −10, 150 ≈ −30). */
export const BEDTIME_LATE_MIN_PER_POINT = 4.5;
/** Going to bed early is free for an hour, then 1 pt / 30 min, capped at 6. */
export const BEDTIME_EARLY_GRACE_MIN = 60;
export const BEDTIME_EARLY_MIN_PER_POINT = 30;
export const BEDTIME_EARLY_MAX_PENALTY = 6;
/** The first 11 minutes awake and the first 2 awakenings are free. */
export const AWAKE_FREE_MINUTES = 11;
export const AWAKE_POINTS_PER_MINUTE = 0.15;
export const WAKE_FREE_COUNT = 2;
export const WAKE_POINTS_PER_EVENT = 0.55;
/** Bedtime consistency looks back this many nights (Apple: 13). */
export const BEDTIME_REFERENCE_NIGHTS = 13;

export interface ScoreBreakdown {
  duration: number;
  bedtime: number;
  interruptions: number;
  total: number;
}

export function scoreNightBreakdown(input: ScoreInput): ScoreBreakdown {
  const short = Math.max(0, DURATION_TARGET_HOURS - input.asleepHours);
  const duration = Math.max(0, 50 - DURATION_POINTS_PER_HOUR_SHORT * short);

  let bedtime = 24; // neutral until a reference exists
  if (input.bedtimeMinutes != null && input.referenceBedtimeMinutes != null) {
    // Signed deviation, later = positive, wrapped around midnight.
    let dev = input.bedtimeMinutes - input.referenceBedtimeMinutes;
    if (dev > 12 * 60) dev -= 24 * 60;
    if (dev < -12 * 60) dev += 24 * 60;
    let penalty = 0;
    if (dev > 0) {
      penalty = Math.max(0, dev - BEDTIME_LATE_GRACE_MIN) / BEDTIME_LATE_MIN_PER_POINT;
    } else {
      penalty = Math.min(
        BEDTIME_EARLY_MAX_PENALTY,
        Math.max(0, -dev - BEDTIME_EARLY_GRACE_MIN) / BEDTIME_EARLY_MIN_PER_POINT,
      );
    }
    bedtime = Math.max(30 - penalty, 0);
  }

  let interruptions = 14; // neutral when awakenings are unknown
  if (input.awakeHours != null || input.wakeCount != null) {
    const minutes = (input.awakeHours ?? 0) * 60;
    const events = input.wakeCount ?? 0;
    interruptions = Math.max(
      20 -
        Math.max(0, minutes - AWAKE_FREE_MINUTES) * AWAKE_POINTS_PER_MINUTE -
        Math.max(0, events - WAKE_FREE_COUNT) * WAKE_POINTS_PER_EVENT,
      0,
    );
  }

  const total = Math.round(duration + bedtime + interruptions);
  return {
    duration: Math.round(duration),
    bedtime: Math.round(bedtime),
    interruptions: Math.round(interruptions),
    total,
  };
}

export function scoreNight(input: ScoreInput): number {
  return scoreNightBreakdown(input).total;
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
