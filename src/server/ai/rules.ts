// rules.ts
// Deterministic, research-backed layer of the temperature advisor.
//
// Evidence base (see README "AI Autopilot" section for sources):
// - Sleep onset requires a 1-2°C core temperature drop; mild bed warmth at
//   bedtime (distal skin warming) shortens sleep-onset latency.
// - The relationship between bed temperature and sleep depth is a sweet spot,
//   not "cooler is better": heat exposure above the comfort band suppresses
//   both slow-wave sleep and REM, yet Raymann & Van Someren (Brain, 2008)
//   showed that MILD skin warming within the comfort band (+0.4°C) enhanced
//   slow-wave sleep and cut early-morning awakenings dramatically. Direction
//   must come from the sleeper's own signals, not a fixed prior.
// - Slightly warmer temperatures promote REM sleep, which dominates the late
//   night; gentle pre-wake warming eases waking.
// - Overheating shows up as toss-and-turn clusters and elevated heart rate
//   together with high bed temperature; restlessness (and elevated cardiac
//   response) at low bed temperature suggests cold stress instead.
// - Eight Sleep's published Sleep Stage Autopilot study (SLEEP 2025, 34
//   users): stage-based adjustment raised deep sleep +4.7 min and HRV +4.9 ms
//   and cut HR -2.3 bpm; their protocol escalates the offset magnitude when
//   deep sleep is under 15% or REM under 20% of the night. Notably, warmer
//   bed temperatures correlated with REDUCED wake time in the same data.
import { type SleepContext } from "./sleepData";
import { type SleepStage } from "./time";

export const DEEP_TARGET_FRACTION = 0.15;
export const REM_TARGET_FRACTION = 0.2;

// Bed temperature (°C, as reported by the pod) above which restlessness is
// read as overheating, and below which it is read as cold discomfort. The
// optimal skin/bed microclimate sits around 31-35°C.
//
// THESE ABSOLUTE THRESHOLDS ARE A SAFETY RAIL ONLY — they must never be the
// primary gate. `tempBedC` is the MEASURED surface temperature with a body on
// it, which sits at 30-32°C on both of these accounts whatever the setpoint
// is (setpoints of 25.6-28.8°C measured 28.7-31.9°C). So "measured >= 30"
// fired almost every night and "measured <= 27" essentially never could:
// between 2026-08-24 and 08-29 every single one of the twenty live nudges
// across both accounts was a COOLING, including on the two nights one sleeper
// reported waking up cold. The real signal is relative — warmer or cooler
// than this sleeper's own night — see computeLiveNudge.
export const HOT_BED_TEMP_C = 30;
export const COLD_BED_TEMP_C = 27;

/** How far the recent window must sit from the night's own mean bed
 *  temperature before that counts as drift rather than noise. */
export const BED_DRIFT_C = 0.3;

// Live tuning: one nudge step and the hard cap on the total offset a single
// night may accumulate away from the planned level. Units are tenths of a
// degree Celsius (5 = 0.5°C per nudge, at most 1.5°C total drift).
export const LIVE_NUDGE_STEP = 5;
export const LIVE_OFFSET_CAP = 15;

// ---------------------------------------------------------------------------
// Movement-burst trigger (researched 2026-08-30; sources in README).
//
// The evidence that shaped each constant:
// - Healthy adults move a MEDIAN of ~11 times per hour, mostly in light sleep
//   and around stage transitions (video-PSG, SLEEP 2024, PMC11381566) — so an
//   absolute movement count can never be the trigger. The burst is judged
//   against THIS night's own toss rate.
// - Restlessness is far more often a heat problem than a cold one: heat
//   directly fragments sleep architecture while cold under bedding is largely
//   buffered (PMC3427038). The burst path therefore only ever COOLS; cold
//   correction belongs to the nightly pass.
// - Movement alone is non-specific (bladder, partner, noise, apnea arousal),
//   so a burst acts only when a thermal corroborant agrees: bed temperature
//   drifting above the night's mean, or elevated heart rate with the bed not
//   running cold (U-shaped heat–restlessness dose response, S1087079224000194).
// - The water loop takes ~10+ minutes to change what the skin feels, so
//   reacting faster than that chases noise and oscillates: one step, then a
//   cooldown longer than the actuation lag before another may fire.
// - Movement naturally rises before waking and the final stage is a
//   deliberate pre-wake warming ramp (REM runs warm; commercial systems ramp
//   +°C before the alarm), so the last 45 minutes are hands-off.
// ---------------------------------------------------------------------------

/** Short window a burst is measured over, in minutes. */
export const BURST_WINDOW_MIN = 15;
/** Fewest tosses in the burst window that can count as a burst. */
export const BURST_MIN_TOSSES = 2;
/** The burst's hourly rate must exceed this multiple of the night's own
 *  toss rate — the personal-baseline gate that absolute counts cannot give. */
export const BURST_BASELINE_MULT = 2;
/** Minutes that must pass after any live nudge before another may fire. */
export const LIVE_NUDGE_COOLDOWN_MIN = 25;
/** Minutes before the alarm during which no nudge may fire. */
export const PRE_WAKE_QUIET_MIN = 45;

// A night is considered a regression when its score falls this many points
// below the best-known night; two in a row triggers a revert to best.
export const REGRESSION_SCORE_DROP = 8;

export function deriveNightSignals(context: SleepContext): string[] {
  const signals: string[] = [];
  const session = context.recentSessions[0];
  if (!session) return signals;

  const totalHours = Object.values(session.stageHours).reduce(
    (sum, h) => sum + h,
    0,
  );
  if (totalHours > 0) {
    const deepFraction = (session.stageHours.deep ?? 0) / totalHours;
    const remFraction = (session.stageHours.rem ?? 0) / totalHours;
    if (deepFraction < DEEP_TARGET_FRACTION) {
      const earlyBedTemp =
        session.avgBedTempC.firstThird ?? session.avgBedTempC.middleThird;
      const direction =
        earlyBedTemp != null && earlyBedTemp >= HOT_BED_TEMP_C
          ? "the bed ran warm early in the night, so cool the deep stage"
          : earlyBedTemp != null && earlyBedTemp <= COLD_BED_TEMP_C
            ? "the bed ran cool early in the night, so mild warming of the deep stage may deepen sleep (Raymann 2008)"
            : "adjust the deep stage in the direction the restlessness data and past nights support";
      signals.push(
        `Deep sleep was ${(deepFraction * 100).toFixed(0)}% of the night (target ≥15%): ${direction}.`,
      );
    }
    if (remFraction < REM_TARGET_FRACTION) {
      signals.push(
        `REM was ${(remFraction * 100).toFixed(0)}% of the night (target ≥20%): research supports a slightly warmer final stage to promote REM.`,
      );
    }
  }

  const thirds = [
    ["first third", session.tossesAndTurns.firstThird, session.avgBedTempC.firstThird, "initial stage"],
    ["middle third", session.tossesAndTurns.middleThird, session.avgBedTempC.middleThird, "mid stage"],
    ["final third", session.tossesAndTurns.finalThird, session.avgBedTempC.finalThird, "final stage"],
  ] as const;
  for (const [label, tosses, bedTemp, stageName] of thirds) {
    if (tosses != null && tosses >= 8 && bedTemp != null) {
      if (bedTemp >= HOT_BED_TEMP_C) {
        signals.push(
          `${tosses} tosses in the ${label} at ${bedTemp}°C bed temperature: the ${stageName} looks too warm.`,
        );
      } else if (bedTemp <= COLD_BED_TEMP_C) {
        signals.push(
          `${tosses} tosses in the ${label} at only ${bedTemp}°C bed temperature: the ${stageName} may be too cold.`,
        );
      }
    }
  }

  return signals;
}

export interface LiveWindowStats {
  recentTosses: number | null;
  recentAvgHeartRate: number | null;
  nightAvgHeartRate: number | null;
  recentAvgBedTempC: number | null;
  currentStage: SleepStage;
  currentOffset: number;
  /** The night's own mean measured bed temperature so far — the reference the
   *  recent window is judged against, instead of an absolute threshold. */
  nightAvgBedTempC: number | null;
  /** What the sleeper reported about recent nights, if anything. A person
   *  saying "I woke up cold" outranks any inference from movement. */
  comfortBias: "cooler" | "warmer" | null;
  /** Which way the sleeper moved the dial TONIGHT, if they did. This is
   *  tonight's statement, made in the moment, and it outranks reports about
   *  previous nights: on 2026-08-30 the sleeper turned the bed 3.4°C warmer
   *  at 00:40 and the tuner cooled it back one second later, citing a
   *  day-old "too hot" report. Never nudge against a hand on the dial. */
  overrideTonight: "cooler" | "warmer" | null;
  /** Tosses in the last BURST_WINDOW_MIN minutes. */
  burstTosses: number | null;
  /** This night's own toss rate so far, per hour — the personal baseline. */
  nightTossRatePerHour: number | null;
  /** Minutes until the alarm; nothing fires inside PRE_WAKE_QUIET_MIN. */
  minutesToWake: number | null;
  /** Minutes since the last AI nudge tonight (manual moves excluded);
   *  null = none yet. Nothing fires inside LIVE_NUDGE_COOLDOWN_MIN. */
  minutesSinceLastNudge: number | null;
}

export interface LiveNudge {
  delta: number;
  reason: string;
}

// Decides one small live adjustment from the last ~45 minutes of the
// in-progress session. Deterministic on purpose: it runs every 30 minutes all
// night, must be predictable, and must fail toward "do nothing".
export function computeLiveNudge(stats: LiveWindowStats): LiveNudge | null {
  const {
    recentTosses,
    recentAvgHeartRate,
    nightAvgHeartRate,
    recentAvgBedTempC,
    nightAvgBedTempC,
    currentStage,
    currentOffset,
    comfortBias,
    overrideTonight,
    burstTosses,
    nightTossRatePerHour,
    minutesToWake,
    minutesSinceLastNudge,
  } = stats;

  // Quiet period before the alarm: movement naturally rises approaching wake
  // and the final stage is a deliberate warming ramp — a nudge here is almost
  // always a false positive fighting the ramp.
  if (minutesToWake != null && minutesToWake <= PRE_WAKE_QUIET_MIN) return null;

  // Cooldown: a water loop takes ~10+ minutes to change what the skin feels.
  // Stacking a second step before the first has landed is how a controller
  // chases noise into oscillation.
  if (
    minutesSinceLastNudge != null &&
    minutesSinceLastNudge < LIVE_NUDGE_COOLDOWN_MIN
  ) {
    return null;
  }

  // A hand on the dial tonight silences any bias carried over from previous
  // nights — the person has already stated tonight's answer at the level they
  // chose. The tuner neither fights it (vetoes below) nor piles on top of it:
  // it may only move further in their direction when the bed's own drift
  // corroborates.
  const bias = overrideTonight != null ? null : comfortBias;

  const restless = recentTosses != null && recentTosses >= 3;
  const elevatedHeartRate =
    recentAvgHeartRate != null &&
    nightAvgHeartRate != null &&
    recentAvgHeartRate >= nightAvgHeartRate * 1.05;

  // Drift relative to THIS night's own bed temperature. Positive means the
  // recent window is running warmer than the night has been.
  const drift =
    recentAvgBedTempC != null && nightAvgBedTempC != null
      ? recentAvgBedTempC - nightAvgBedTempC
      : null;

  // ---- Movement-burst fast path -------------------------------------------
  // A concentrated burst against the sleeper's own baseline reacts in one
  // BURST_WINDOW_MIN window instead of waiting for the slow 45-minute count.
  // It only ever cools, and only with a thermal corroborant: bed drifting
  // warm, or heart rate elevated while the bed is not running cold.
  const burstRatePerHour =
    burstTosses != null ? burstTosses / (BURST_WINDOW_MIN / 60) : null;
  const burst =
    burstTosses != null &&
    burstTosses >= BURST_MIN_TOSSES &&
    burstRatePerHour != null &&
    nightTossRatePerHour != null &&
    burstRatePerHour >= BURST_BASELINE_MULT * Math.max(nightTossRatePerHour, 1);
  const burstCorroborated =
    (drift != null && drift >= BED_DRIFT_C) ||
    (elevatedHeartRate && (drift == null || drift >= 0));
  if (
    burst &&
    burstCorroborated &&
    overrideTonight !== "warmer" &&
    bias !== "warmer" &&
    currentOffset - LIVE_NUDGE_STEP >= -LIVE_OFFSET_CAP
  ) {
    const corroborant =
      drift != null && drift >= BED_DRIFT_C
        ? `the bed running ${drift.toFixed(1)}°C above its average for tonight`
        : `heart rate ${recentAvgHeartRate} vs night average ${nightAvgHeartRate}`;
    return {
      delta: -LIVE_NUDGE_STEP,
      reason: `Cooling by ${LIVE_NUDGE_STEP / 10}°C: ${burstTosses} tosses in the last ${BURST_WINDOW_MIN} minutes — well above your pace tonight — with ${corroborant}.`,
    };
  }
  // -------------------------------------------------------------------------

  const disturbed = restless || elevatedHeartRate;
  if (!disturbed) return null;

  const trigger = restless
    ? `${recentTosses} tosses in the last 45 minutes`
    : `heart rate ${recentAvgHeartRate} vs night average ${nightAvgHeartRate}`;

  // What the sleeper said wins outright: they are the only direct reading
  // of comfort available, and an inference from movement cannot overrule it.
  if (bias === "warmer" && currentStage !== "initial") {
    if (currentOffset + LIVE_NUDGE_STEP > LIVE_OFFSET_CAP) return null;
    return {
      delta: LIVE_NUDGE_STEP,
      reason: `Warming by ${LIVE_NUDGE_STEP / 10}°C: you reported waking up cold, and there were ${trigger}.`,
    };
  }
  if (bias === "cooler") {
    if (currentOffset - LIVE_NUDGE_STEP < -LIVE_OFFSET_CAP) return null;
    return {
      delta: -LIVE_NUDGE_STEP,
      reason: `Cooling by ${LIVE_NUDGE_STEP / 10}°C: you reported the bed running hot, and there were ${trigger}.`,
    };
  }

  if (drift == null) return null;

  if (drift >= BED_DRIFT_C) {
    // Never cool against a hand that turned the bed up tonight.
    if (overrideTonight === "warmer") return null;
    if (currentOffset - LIVE_NUDGE_STEP < -LIVE_OFFSET_CAP) return null;
    return {
      delta: -LIVE_NUDGE_STEP,
      reason: `Cooling by ${LIVE_NUDGE_STEP / 10}°C: the bed has drifted ${drift.toFixed(1)}°C above its average for tonight (${recentAvgBedTempC}°C) with ${trigger}.`,
    };
  }

  if (drift <= -BED_DRIFT_C && currentStage !== "initial") {
    if (overrideTonight === "cooler") return null;
    if (currentOffset + LIVE_NUDGE_STEP > LIVE_OFFSET_CAP) return null;
    return {
      delta: LIVE_NUDGE_STEP,
      reason: `Warming by ${LIVE_NUDGE_STEP / 10}°C: the bed has drifted ${Math.abs(drift).toFixed(1)}°C below its average for tonight (${recentAvgBedTempC}°C) with ${trigger}.`,
    };
  }

  return null;
}
