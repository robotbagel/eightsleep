// control.ts
// The control law for the nightly temperature profile.
//
// WHY THIS EXISTS. The first version asked the model, every single morning,
// "what should tonight's four temperatures be?" and applied the answer. Over
// 2026-08-23..29 that produced this on one account:
//
//   mid   26.5 → 26 → 26.5 → 25.6 → 24.5 → 25.6 → 26.5 → 26 → 26.5
//   final 28.8 → 28 → 28.8 → 28.4 → 28   → 27   → 28.8 → 28.6 → 28.8
//
// Seven nights of daily changes that ended exactly where they started, having
// swung ±2°C in between. Four causes, all structural rather than a bad answer
// on any given day:
//
//   1. WRONG OBJECTIVE. It maximised the overall sleep score, which is half
//      duration and a third bedtime consistency — neither of which a bed can
//      change. Measured on that week the score correlated +0.67 with time
//      asleep and −0.38 with deep sleep, so the loop was steering away from
//      the one thing it exists to improve. Now it optimises `thermalScore`.
//
//   2. NO EXPERIMENT DISCIPLINE. A change was judged on the single night that
//      followed and then revisited immediately, while the interruption term
//      alone can swing 20 points on a noisy sensor count. Now a profile is
//      judged on the MEAN of every verified night it was held, and a change is
//      held for MIN_HOLD_NIGHTS before that stage may move again.
//
//   3. THE TWO CONTROLLERS FOUGHT. Live tuning cooled mid and final on five
//      nights running — ten corrections, every one a cooling, never a warming
//      — while the morning pass kept warming those same stages back up. The
//      fast loop's evidence was thrown away nightly. Repeated live corrections
//      are now the STRONGEST evidence available and get folded into the base
//      deterministically, because "the bed was too warm here again last night"
//      is a measurement, not a guess.
//
//   4. NO STOPPING CONDITION. Nothing ever said "this is good enough". A
//      controller without a dead-band oscillates by construction, so there is
//      now an explicit converged state.
import { rawToCelsius, celsiusToRaw } from "~/lib/temperature";

export const STAGES = ["initial", "deep", "mid", "final"] as const;
export type Stage = (typeof STAGES)[number];

export interface ProfileLevels {
  initial: number;
  deep: number;
  mid: number;
  final: number;
}

/** Nights a change is held before that stage may be revisited. */
export const MIN_HOLD_NIGHTS = 2;
/** Live corrections in one direction on this many of the last 3 nights is a
 *  measurement worth acting on rather than a one-off bad night. */
export const LIVE_REPEAT_THRESHOLD = 2;
/** Within this many thermal points of the best profile, stop fiddling. */
export const CONVERGENCE_MARGIN = 3;
/** Never fold more than this into the base in one step, whatever live tuning
 *  accumulated overnight. */
export const MAX_FOLD_C = 1;

export interface ScoredNight {
  date: string;
  thermalScore: number;
  overallScore: number | null;
  profile: ProfileLevels;
  verified: boolean;
}

export interface LedgerEntry {
  profile: ProfileLevels;
  nights: string[];
  meanThermal: number;
  best: boolean;
  current: boolean;
}

export const fingerprint = (p: ProfileLevels) =>
  `${p.initial}/${p.deep}/${p.mid}/${p.final}`;

/**
 * Groups verified nights by the profile that was actually in force, so a
 * profile is judged on its average rather than on whichever single night
 * happened to follow it.
 */
export function buildLedger(
  nights: ScoredNight[],
  current: ProfileLevels,
): LedgerEntry[] {
  const byProfile = new Map<string, { profile: ProfileLevels; nights: ScoredNight[] }>();
  for (const night of nights) {
    if (!night.verified) continue;
    const key = fingerprint(night.profile);
    const bucket = byProfile.get(key) ?? { profile: night.profile, nights: [] };
    bucket.nights.push(night);
    byProfile.set(key, bucket);
  }

  const entries: LedgerEntry[] = [...byProfile.values()].map((bucket) => ({
    profile: bucket.profile,
    nights: bucket.nights.map((n) => n.date),
    meanThermal:
      Math.round(
        (bucket.nights.reduce((sum, n) => sum + n.thermalScore, 0) /
          bucket.nights.length) *
          10,
      ) / 10,
    best: false,
    current: fingerprint(bucket.profile) === fingerprint(current),
  }));

  // Only profiles with enough nights to mean anything can be "best".
  const eligible = entries.filter((e) => e.nights.length >= MIN_HOLD_NIGHTS);
  const pool = eligible.length > 0 ? eligible : entries;
  let top: LedgerEntry | null = null;
  for (const entry of pool) {
    if (!top || entry.meanThermal > top.meanThermal) top = entry;
  }
  if (top) top.best = true;

  return entries.sort((a, b) => b.meanThermal - a.meanThermal);
}

export interface LivePressure {
  stage: Stage;
  /** Negative = live tuning kept cooling this stage. In °C. */
  meanOffsetC: number;
  nights: number;
}

/**
 * How often, and in which direction, live tuning had to correct each stage
 * over the recent nights. A stage corrected the same way on most nights is
 * the base profile being wrong in a way the sleeper feels every night.
 */
export function livePressure(
  adjustments: { night: string; stage: string; newOffset: number }[],
  recentNights: string[],
): LivePressure[] {
  const window = new Set(recentNights);
  // The offset accumulates within a night, so the LAST value for a stage on a
  // night is that night's net correction.
  const netByNightStage = new Map<string, number>();
  for (const adjustment of adjustments) {
    if (!window.has(adjustment.night)) continue;
    netByNightStage.set(
      `${adjustment.night}|${adjustment.stage}`,
      adjustment.newOffset,
    );
  }

  const out: LivePressure[] = [];
  for (const stage of STAGES) {
    const values: number[] = [];
    for (const night of recentNights) {
      const net = netByNightStage.get(`${night}|${stage}`);
      if (net != null && net !== 0) values.push(net / 10); // tenths → °C
    }
    if (values.length === 0) continue;
    const sameDirection = values.every((v) => v < 0) || values.every((v) => v > 0);
    if (!sameDirection) continue;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    out.push({
      stage,
      // Round the MAGNITUDE, not the signed value: Math.round(-7.5) is -7 but
      // Math.round(7.5) is 8, which would quietly make every cooling fold
      // smaller than the equivalent warming one.
      meanOffsetC: Math.sign(mean) * (Math.round(Math.abs(mean) * 10) / 10),
      nights: values.length,
    });
  }
  return out;
}

export type Decision =
  | {
      kind: "fold-live";
      stage: Stage;
      fromC: number;
      toC: number;
      pressure: LivePressure;
    }
  | { kind: "converged"; meanThermal: number; nights: number }
  | { kind: "hold"; reason: string }
  | { kind: "ask-model"; availableStages: Stage[] };

/**
 * Decides what KIND of move tonight is, before any model is involved. The
 * deterministic branches exist because they encode measurements; the model is
 * only asked when there is a genuine choice to make.
 */
export function decide(input: {
  current: ProfileLevels;
  ledger: LedgerEntry[];
  pressure: LivePressure[];
  lockedStages: Stage[];
  /** Which way the most recent change moved each locked stage. A hold exists
   *  to let an experiment run, not to protect one the evidence has already
   *  refuted, so a lock pointing the opposite way to live pressure is void. */
  lockDirection?: Partial<Record<Stage, "cooler" | "warmer">>;
  verifiedNights: number;
  nightsOnCurrentProfile: number;
  maxShiftC: number;
}): Decision {
  const {
    current,
    ledger,
    pressure,
    lockedStages,
    verifiedNights,
    nightsOnCurrentProfile,
    maxShiftC,
  } = input;
  const lockDirection = input.lockDirection ?? {};

  /** A lock is void when the last change went the opposite way to what live
   *  tuning has been correcting since — that experiment is already answered. */
  const heldAgainstEvidence = (stage: Stage): boolean => {
    const locked = lockedStages.includes(stage);
    if (!locked) return false;
    const p = pressure.find((entry) => entry.stage === stage);
    if (!p || p.nights < LIVE_REPEAT_THRESHOLD) return true;
    const pressureWants = p.meanOffsetC < 0 ? "cooler" : "warmer";
    return lockDirection[stage] === pressureWants || lockDirection[stage] == null;
  };

  // 1. Repeated live corrections outrank everything else: the fast loop had to
  //    fix the same stage the same way on most of the recent nights, which is
  //    a measurement of the base being wrong.
  const repeated = pressure
    .filter(
      (p) => p.nights >= LIVE_REPEAT_THRESHOLD && !heldAgainstEvidence(p.stage),
    )
    .sort((a, b) => Math.abs(b.meanOffsetC) - Math.abs(a.meanOffsetC));
  const strongest = repeated[0];
  if (strongest) {
    const fromC = rawToCelsius(current[strongest.stage]);
    const step = Math.max(
      -Math.min(MAX_FOLD_C, maxShiftC),
      Math.min(Math.min(MAX_FOLD_C, maxShiftC), strongest.meanOffsetC),
    );
    const toC = Math.round((fromC + step) * 10) / 10;
    if (celsiusToRaw(toC) !== current[strongest.stage]) {
      return { kind: "fold-live", stage: strongest.stage, fromC, toC, pressure: strongest };
    }
  }

  // 2. Not enough measured nights to say anything yet.
  if (verifiedNights < MIN_HOLD_NIGHTS) {
    return {
      kind: "hold",
      reason: `Only ${verifiedNights} night${verifiedNights === 1 ? "" : "s"} on record where the pod provably ran this schedule. Holding until there is something to compare.`,
    };
  }

  // 3. The current profile has not been measured long enough to judge.
  if (nightsOnCurrentProfile < MIN_HOLD_NIGHTS) {
    return {
      kind: "hold",
      reason: `Tonight is night ${nightsOnCurrentProfile + 1} on this profile. Changing it again before the last change has been measured is how a profile ends up back where it started.`,
    };
  }

  // 4. Good enough — stop fiddling.
  // Matched against the profile actually passed in, not the ledger's own
  // `current` flag: the two can disagree if the profile moved after the
  // ledger was built, and trusting the flag would then judge the wrong row.
  const key = fingerprint(current);
  const currentEntry = ledger.find((entry) => fingerprint(entry.profile) === key);
  const bestEntry = ledger.find((entry) => entry.best);
  if (
    currentEntry &&
    bestEntry &&
    currentEntry.meanThermal >= bestEntry.meanThermal - CONVERGENCE_MARGIN
  ) {
    return {
      kind: "converged",
      meanThermal: currentEntry.meanThermal,
      nights: currentEntry.nights.length,
    };
  }

  const available = STAGES.filter((stage) => !lockedStages.includes(stage));
  if (available.length === 0) {
    return {
      kind: "hold",
      reason: "Every stage is still under measurement from a recent change.",
    };
  }
  return { kind: "ask-model", availableStages: available };
}

/** Human-readable ledger lines for the prompt and the app. */
export function describeLedger(
  ledger: LedgerEntry[],
  format: (raw: number) => string,
): string[] {
  return ledger.map((entry) => {
    const shape = STAGES.map((stage) => format(entry.profile[stage])).join("/");
    const tags = [
      entry.current ? "CURRENT" : null,
      entry.best ? "best so far" : null,
      entry.nights.length < MIN_HOLD_NIGHTS ? "too few nights to judge" : null,
    ].filter(Boolean);
    return `${shape}: thermal ${entry.meanThermal} over ${entry.nights.length} night${entry.nights.length === 1 ? "" : "s"} (${entry.nights.join(", ")})${tags.length ? ` — ${tags.join(", ")}` : ""}`;
  });
}
