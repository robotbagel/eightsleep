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
export const HOT_BED_TEMP_C = 30;
export const COLD_BED_TEMP_C = 27;

// Live tuning: one nudge step and the hard cap on the total offset a single
// night may accumulate away from the planned level. Units are tenths of a
// degree Celsius (5 = 0.5°C per nudge, at most 1.5°C total drift).
export const LIVE_NUDGE_STEP = 5;
export const LIVE_OFFSET_CAP = 15;

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
    currentStage,
    currentOffset,
  } = stats;

  const restless = recentTosses != null && recentTosses >= 3;
  const elevatedHeartRate =
    recentAvgHeartRate != null &&
    nightAvgHeartRate != null &&
    recentAvgHeartRate >= nightAvgHeartRate * 1.05;

  if (
    recentAvgBedTempC != null &&
    recentAvgBedTempC >= HOT_BED_TEMP_C &&
    (restless || elevatedHeartRate)
  ) {
    if (currentOffset - LIVE_NUDGE_STEP < -LIVE_OFFSET_CAP) return null;
    const trigger = restless
      ? `${recentTosses} tosses in the last 45 minutes`
      : `heart rate ${recentAvgHeartRate} vs night average ${nightAvgHeartRate}`;
    return {
      delta: -LIVE_NUDGE_STEP,
      reason: `Cooling by ${LIVE_NUDGE_STEP / 10}°C: bed at ${recentAvgBedTempC}°C with ${trigger}.`,
    };
  }

  // Warm nudges in the mid and final stages when the bed runs cold and the
  // sleeper is restless: mild within-comfort warming deepens sleep and
  // suppresses early-morning waking (Raymann 2008). The initial stage stays
  // at the user's chosen comfort setting.
  if (
    currentStage !== "initial" &&
    recentAvgBedTempC != null &&
    recentAvgBedTempC <= COLD_BED_TEMP_C &&
    restless
  ) {
    if (currentOffset + LIVE_NUDGE_STEP > LIVE_OFFSET_CAP) return null;
    return {
      delta: LIVE_NUDGE_STEP,
      reason: `Warming by ${LIVE_NUDGE_STEP / 10}°C: bed at ${recentAvgBedTempC}°C with ${recentTosses} tosses in the last 45 minutes of the ${currentStage} stage.`,
    };
  }

  return null;
}
