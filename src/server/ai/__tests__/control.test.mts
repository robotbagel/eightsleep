import assert from "node:assert";
import {
  buildLedger, decide, livePressure, MIN_HOLD_NIGHTS,
  type ProfileLevels, type ScoredNight,
} from "../control";

const P = (i: number, d: number, m: number, f: number): ProfileLevels => ({
  initial: i, deep: d, mid: m, final: f,
});
const A = P(22, -12, -8, 17);
const B = P(22, -12, -20, 17);

const night = (date: string, t: number, profile: ProfileLevels, verified = true): ScoredNight =>
  ({ date, thermalScore: t, overallScore: null, profile, verified });

// --- ledger groups by profile and averages -------------------------------
const ledger = buildLedger(
  [night("08-25", 90, A), night("08-26", 80, A), night("08-27", 70, B), night("08-28", 72, B)],
  A,
);
assert.equal(ledger.length, 2);
const forA = ledger.find((e) => e.current)!;
assert.equal(forA.meanThermal, 85, "A averages 85");
assert.ok(forA.best, "A is best");
console.log("ok  ledger averages per profile and marks best/current");

// --- unverified nights never enter the ledger ----------------------------
assert.equal(buildLedger([night("08-25", 99, B, false)], A).length, 0);
console.log("ok  unverified nights are excluded");

// --- live pressure only counts same-direction repeats --------------------
const adj = [
  { night: "08-26", stage: "mid", newOffset: -10 },
  { night: "08-27", stage: "mid", newOffset: -5 },
  { night: "08-28", stage: "final", newOffset: -5 },
  { night: "08-26", stage: "deep", newOffset: -5 },
  { night: "08-27", stage: "deep", newOffset: +5 },
];
const pressure = livePressure(adj, ["08-26", "08-27", "08-28"]);
const mid = pressure.find((p) => p.stage === "mid")!;
assert.equal(mid.nights, 2);
assert.equal(mid.meanOffsetC, -0.8, "mean of -1.0 and -0.5");
assert.ok(!pressure.some((p) => p.stage === "deep"), "mixed directions are not pressure");
console.log("ok  live pressure needs a consistent direction");

// --- repeated cooling folds into the base --------------------------------
const d1 = decide({
  current: A, ledger, pressure, lockedStages: [], verifiedNights: 4,
  nightsOnCurrentProfile: 3, maxShiftC: 3,
});
assert.equal(d1.kind, "fold-live");
assert.equal((d1 as { stage: string }).stage, "mid");
assert.ok((d1 as { toC: number }).toC < (d1 as { fromC: number }).fromC, "folds cooler");
console.log("ok  repeated live cooling is folded into the base");

// --- a locked stage is not folded ----------------------------------------
const d2 = decide({
  current: A, ledger, pressure, lockedStages: ["mid"], verifiedNights: 4,
  nightsOnCurrentProfile: 3, maxShiftC: 3,
});
assert.notEqual(d2.kind, "fold-live");
console.log("ok  a stage under measurement is not folded");

// --- convergence stops the fiddling --------------------------------------
const d3 = decide({
  current: A, ledger, pressure: [], lockedStages: [], verifiedNights: 4,
  nightsOnCurrentProfile: 3, maxShiftC: 3,
});
assert.equal(d3.kind, "converged");
console.log("ok  a profile level with the best converges");

// --- a change is held before it is revisited ------------------------------
const d4 = decide({
  current: B, ledger, pressure: [], lockedStages: [], verifiedNights: 4,
  nightsOnCurrentProfile: 1, maxShiftC: 3,
});
assert.equal(d4.kind, "hold");
console.log("ok  a fresh change is held for a night before judging");

// --- a clearly worse profile gets handed to the model ---------------------
// decide() must find the current row by matching the profile it is given, not
// by trusting the ledger's flag — they disagree whenever the profile moved
// after the ledger was built.
const d5 = decide({
  current: B, ledger, pressure: [], lockedStages: [], verifiedNights: 4,
  nightsOnCurrentProfile: MIN_HOLD_NIGHTS, maxShiftC: 3,
});
assert.equal(d5.kind, "ask-model");
console.log("ok  a worse profile asks the model for one change");

// --- a hold does not protect a change the evidence already refutes --------
// The old loop's last act warmed a stage that live tuning then cooled on two
// of the next three nights. Holding that for a night would lock in a change
// the fast loop has already answered.
const d6 = decide({
  current: A, ledger, pressure, lockedStages: ["mid"],
  lockDirection: { mid: "warmer" },
  verifiedNights: 4, nightsOnCurrentProfile: 1, maxShiftC: 3,
});
assert.equal(d6.kind, "fold-live", "a refuted hold is void");
assert.equal((d6 as { stage: string }).stage, "mid");
console.log("ok  a hold contradicted by live tuning is void");

// ...but a hold pointing the SAME way as the pressure still stands: that
// experiment is running, not refuted.
const d7 = decide({
  current: A, ledger, pressure, lockedStages: ["mid"],
  lockDirection: { mid: "cooler" },
  verifiedNights: 4, nightsOnCurrentProfile: 1, maxShiftC: 3,
});
assert.notEqual(d7.kind, "fold-live");
console.log("ok  a hold agreeing with the evidence still holds");


// --- live nudge direction -------------------------------------------------
// The old rule gated on ABSOLUTE measured bed temperature, which includes body
// heat and sits at 30-32°C whatever the setpoint — so cooling fired nightly
// and warming essentially never could. Twenty consecutive coolings across two
// accounts, including on nights a sleeper reported waking up cold.
const { computeLiveNudge } = await import("../rules");

const base = {
  recentTosses: 4,
  recentAvgHeartRate: 60,
  nightAvgHeartRate: 59,
  currentStage: "mid" as const,
  currentOffset: 0,
  comfortBias: null,
};

const cold = computeLiveNudge({
  ...base,
  recentAvgBedTempC: 30.0,
  nightAvgBedTempC: 30.6,
});
assert.ok(cold && cold.delta > 0, "a bed below its own night average warms");
console.log("ok  a bed running cool for this night warms, at any absolute temperature");

const hot = computeLiveNudge({
  ...base,
  recentAvgBedTempC: 31.2,
  nightAvgBedTempC: 30.6,
});
assert.ok(hot && hot.delta < 0, "a bed above its own night average cools");
console.log("ok  a bed running warm for this night cools");

const steady = computeLiveNudge({
  ...base,
  recentAvgBedTempC: 30.6,
  nightAvgBedTempC: 30.6,
});
assert.equal(steady, null, "no drift, no nudge");
console.log("ok  no drift means no nudge");

// A reported "too cold" warms even while the bed reads 31°C, which every
// absolute threshold in the old rule would have called hot.
const reportedCold = computeLiveNudge({
  ...base,
  recentAvgBedTempC: 31.0,
  nightAvgBedTempC: 30.4,
  comfortBias: "warmer",
});
assert.ok(reportedCold && reportedCold.delta > 0, "what the sleeper said wins");
console.log("ok  a reported 'too cold' warms even when the bed reads hot");

const calm = computeLiveNudge({
  ...base,
  recentTosses: 0,
  recentAvgHeartRate: 58,
  recentAvgBedTempC: 31.5,
  nightAvgBedTempC: 30.4,
  comfortBias: "warmer",
});
assert.equal(calm, null, "a settled sleeper is never disturbed");
console.log("ok  an undisturbed sleeper is left alone whatever the bias");

console.log("\nall control-law assertions passed");
