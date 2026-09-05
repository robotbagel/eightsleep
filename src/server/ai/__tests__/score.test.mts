import assert from "node:assert";
import { scoreNightBreakdown, scoreNight } from "../score";
import { awakeAfterOnsetHours, wakeEventCount, type PodSession } from "../sleepData";

// --- Apple's own per-term breakdown for five nights (screenshots, 1–5 Sep 2026)
// Each: asleep h, bedtime deviation min (later = +), wake-ups, awake min → Apple's terms
const apple: [string, number, number, number, number, number, number, number][] = [
  ["09-05", 6 + 20 / 60, -11, 6, 24, 39, 30, 16],
  ["09-04", 6 + 4 / 60, +14, 6, 36, 37, 30, 14],
  ["09-03", 6 + 33 / 60, +15, 5, 12, 41, 30, 18],
  ["09-02", 6 + 4 / 60, -4, 4, 11, 37, 30, 19],
  ["09-01", 6 + 24 / 60, -11, 1, 9, 40, 30, 20],
];
for (const [night, asleep, dev, wakes, awakeMin, d, b, i] of apple) {
  const r = scoreNightBreakdown({
    asleepHours: asleep,
    awakeHours: awakeMin / 60,
    wakeCount: wakes,
    bedtimeMinutes: 60 + dev,
    referenceBedtimeMinutes: 60,
  });
  assert.equal(r.duration, d, `${night} duration ${r.duration} vs Apple ${d}`);
  assert.equal(r.bedtime, b, `${night} bedtime ${r.bedtime} vs Apple ${b}`);
  assert.ok(Math.abs(r.interruptions - i) <= 1, `${night} interruptions ${r.interruptions} vs Apple ${i}`);
  assert.ok(Math.abs(r.total - (d + b + i)) <= 1, `${night} total ${r.total} vs Apple ${d + b + i}`);
}
console.log("ok  rubric reproduces Apple's five known breakdowns");

// --- reading in bed before sleep must not count as interruptions ----------
const base: PodSession = {
  sleepStart: "2026-09-04T22:08:30.000Z",
  sleepEnd: "2026-09-05T04:58:00.000Z",
  stageSummary: {
    sleepDuration: 23670,
    awakeDuration: 6150,
    awakeBeforeSleepDuration: 3270,
    awakeBetweenSleepDuration: 900,
    awakeAfterSleepDuration: 1980,
    wasoDuration: 900,
  },
  timeseries: {
    shortAwakes: [
      ["2026-09-04T21:30:00.000Z", 1], // before sleep onset: not an interruption
      ["2026-09-04T23:03:30.000Z", 1],
      ["2026-09-04T23:06:30.000Z", 1], // 3 min later: same awakening
      ["2026-09-05T02:00:00.000Z", 1],
      ["2026-09-05T05:10:00.000Z", 1], // after the final wake
    ],
  },
};
assert.equal(awakeAfterOnsetHours(base), 0.25, "WASO is the pod's wasoDuration");
assert.equal(wakeEventCount(base), 2, "in-window markers merged within 10 min");
const scored = scoreNight({
  asleepHours: 23670 / 3600,
  awakeHours: awakeAfterOnsetHours(base),
  wakeCount: wakeEventCount(base),
  bedtimeMinutes: 8,
  referenceBedtimeMinutes: 19,
});
assert.ok(scored >= 88, `night scores ${scored}; the 54 min in bed before sleep must not cost points`);
const withTotalAwake = scoreNight({
  asleepHours: 23670 / 3600,
  awakeHours: 6150 / 3600,
  wakeCount: 5,
  bedtimeMinutes: 8,
  referenceBedtimeMinutes: 19,
});
assert.ok(scored - withTotalAwake >= 10, "the old total-awake input is what sank the score");
console.log("ok  awake-before-sleep and after-wake are not interruptions");

// --- fallback: no summary fields → trimmed hypnogram ----------------------
const hypno: PodSession = {
  sleepStart: base.sleepStart,
  sleepEnd: base.sleepEnd,
  stageSummary: { sleepDuration: 20000 },
  stages: [
    { stage: "awake", duration: 3000 },
    { stage: "light", duration: 6000 },
    { stage: "awake", duration: 600 },
    { stage: "deep", duration: 6000 },
    { stage: "awake", duration: 1200 },
    { stage: "out", duration: 300 },
  ],
};
assert.equal(awakeAfterOnsetHours(hypno), 600 / 3600, "only the awake run between sleep runs counts");
assert.equal(wakeEventCount(hypno), null, "no shortAwakes series → unknown");
console.log("ok  hypnogram fallback trims leading/trailing awake");

// --- bedtime: free 15 min late, free 60 min early, wraps midnight ----------
const bt = (dev: number) =>
  scoreNightBreakdown({ asleepHours: 8, awakeHours: 0, wakeCount: 0, bedtimeMinutes: (30 + dev + 1440) % 1440, referenceBedtimeMinutes: 30 }).bedtime;
assert.equal(bt(15), 30);
assert.equal(bt(60), 20);
assert.equal(bt(150), 0);
assert.equal(bt(-60), 30);
assert.equal(bt(-90), 29);
assert.equal(bt(-400), 24, "early penalty capped at 6");
console.log("ok  bedtime grace and caps");

// --- duration: full marks from 7h40, no bonus above ------------------------
assert.equal(scoreNightBreakdown({ asleepHours: 9, awakeHours: 0, wakeCount: 0, bedtimeMinutes: null, referenceBedtimeMinutes: null }).duration, 50);
assert.equal(scoreNightBreakdown({ asleepHours: 7.67, awakeHours: 0, wakeCount: 0, bedtimeMinutes: null, referenceBedtimeMinutes: null }).duration, 50);
console.log("ok  duration saturates at the target");

// --- thermal score: sleep-onset latency is a term --------------------------
import { thermalScore, LATENCY_TARGET_MIN } from "../score";
import { sleepLatencyHours } from "../sleepData";
const quick = thermalScore({ asleepHours: 6.5, deepHours: 1.2, remHours: 1.4, awakeHours: 0.3, tosses: 15, latencyMinutes: 12 });
const slow = thermalScore({ asleepHours: 6.5, deepHours: 1.2, remHours: 1.4, awakeHours: 0.3, tosses: 15, latencyMinutes: 55 });
const unknown = thermalScore({ asleepHours: 6.5, deepHours: 1.2, remHours: 1.4, awakeHours: 0.3, tosses: 15, latencyMinutes: null });
assert.ok(quick! > slow!, `a 55-min onset (${slow}) must score below a 12-min one (${quick})`);
assert.ok(quick! >= unknown! - 1, "a fast onset never costs against an unknown one");
assert.equal(
  thermalScore({ asleepHours: 6.5, deepHours: 1.2, remHours: 1.4, awakeHours: 0.3, tosses: 15, latencyMinutes: LATENCY_TARGET_MIN }),
  quick,
  "anything inside the target is full marks",
);
assert.equal(sleepLatencyHours(base), 3270 / 3600, "latency = the pod's awakeBeforeSleepDuration");
assert.equal(sleepLatencyHours(hypno), 3000 / 3600, "fallback: leading awake runs of the hypnogram");
console.log("ok  sleep-onset latency scores and reads");

// --- second opinion --------------------------------------------------------
import { compareSources } from "../secondOpinion";
const pod = { score: 79, asleepHours: 6.08, awakeHours: 56 / 60, wakeCount: 5, deepHours: 1.2, remHours: 1.5 };
const watch = { score: 86, asleepHours: 6.07, awakeHours: 11 / 60, wakeCount: 4, deepHours: 1.0, remHours: 1.3 };
const opinion = compareSources(pod, watch);
assert.equal(opinion.score, 86);
assert.equal(opinion.disagreements.length, 1, JSON.stringify(opinion.disagreements));
assert.ok(opinion.disagreements[0]!.startsWith("Awake mid-night: pod 56m, Watch 11m"));
assert.equal(compareSources(pod, { ...pod }).disagreements.length, 0, "identical readings agree");
console.log("ok  second opinion flags only real disagreements");

// --- latency reaches the model as a signal and the sleeper as an observation
import { deriveNightSignals, LATENCY_SIGNAL_MIN } from "../rules";
import { observation } from "../why";
const detail = (latency: number | null, firstThirdBedC: number | null) => ({
  date: "2026-09-05",
  score: 89,
  stageHours: { deep: 0.9, rem: 1.3, light: 4.4, awake: 0.3 },
  sleepLatencyMinutes: latency,
  tossesAndTurns: { firstThird: 4, middleThird: 11, finalThird: 13 },
  avgBedTempC: { firstThird: firstThirdBedC, middleThird: 30.4, finalThird: 30.4 },
  avgRoomTempC: 22,
  avgHeartRate: 58,
});
const slowOnset = deriveNightSignals({
  nights: [],
  recentSessions: [detail(54, 31.2), detail(60, 30.8), detail(36, 30.9)],
});
const latencySignal = slowOnset.find((s) => s.startsWith("Took 50 min on average to fall asleep"));
assert.ok(latencySignal, `expected a latency signal, got ${JSON.stringify(slowOnset)}`);
assert.ok(latencySignal!.includes("cooler initial stage"), "warm first third → cool the onset");
const fastOnset = deriveNightSignals({ nights: [], recentSessions: [detail(12, 31.2), detail(15, 30.8)] });
assert.ok(!fastOnset.some((s) => s.includes("fall asleep")), "inside the target: no signal");
const oneBadNight = deriveNightSignals({ nights: [], recentSessions: [detail(60, 31), detail(10, 31), detail(10, 31)] });
assert.ok(!oneBadNight.some((s) => s.includes("fall asleep")), `one slow night alone (mean 27 < ${LATENCY_SIGNAL_MIN}) does not fire`);
const said = observation({ stage: "initial", direction: "cooler", tosses: 4, bedTempC: 31.2, latencyMinutes: 54, liveNights: null, reportedNights: null });
assert.ok(said.includes("took you 54 minutes to fall asleep"), said);
const deepSaid = observation({ stage: "deep", direction: "warmer", tosses: 6, bedTempC: 29.1, latencyMinutes: 54, liveNights: 2, reportedNights: null });
assert.ok(!deepSaid.includes("fall asleep"), "latency is only cited for the first stage");
console.log("ok  latency signal and explanation");
