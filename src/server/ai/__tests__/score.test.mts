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
