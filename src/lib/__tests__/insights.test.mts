import assert from "node:assert";
import { buildInsight, ratingFor, type InsightNight } from "../insights";

const usual = (night: string, over: Partial<InsightNight> = {}): InsightNight => ({
  night,
  asleepHours: 7,
  deepHours: 1.2,
  remHours: 1.5,
  tosses: 14,
  wakeCount: 6,
  sleepLatencyHours: 0.3,
  restingHeartRate: 47,
  hrv: 60,
  respiratoryRate: 15.7,
  thermalScore: 84,
  ...over,
});
const history = Array.from({ length: 10 }, (_, i) =>
  usual(`2026-09-${String(i + 1).padStart(2, "0")}`, {
    asleepHours: 7 + (i % 3) * 0.1,
    restingHeartRate: 46 + (i % 3),
    respiratoryRate: 15.5 + (i % 3) * 0.2,
  }),
);

// --- Apple's bands -------------------------------------------------------
assert.equal(ratingFor(84), "High");
assert.equal(ratingFor(96), "Very high");
assert.equal(ratingFor(61), "OK");
assert.equal(ratingFor(40), "Very low");
assert.equal(ratingFor(null), null);
console.log("ok  scores read on Apple's Sleep Score bands");

// --- a night much like the others ----------------------------------------
const typical = buildInsight(usual("2026-09-20"), history);
assert.equal(typical.headline, "A Good Night's Sleep");
assert.ok(typical.contributors.every((c) => c.effect !== "held-back"));
assert.equal(typical.vitalsStatus, "Typical");
assert.equal(typical.tip, null, "nothing stands out, so nothing to try");
console.log("ok  an ordinary night says so and suggests nothing");

// --- slow to fall asleep leads, with a concrete action --------------------
const slow = buildInsight(usual("2026-09-20", { sleepLatencyHours: 0.9, thermalScore: 70 }), history);
assert.equal(slow.headline, "Slow to Fall Asleep");
assert.ok(slow.summary.startsWith("It took you 54 min to fall asleep"), slow.summary);
assert.ok(slow.tip?.includes("press −"), "the tip names the action");
console.log("ok  the weakest driver leads the headline and the tip");

// --- deep sleep up ------------------------------------------------------
const deep = buildInsight(usual("2026-09-20", { deepHours: 1.8, thermalScore: 90 }), history);
assert.equal(deep.headline, "More Deep Sleep Than Usual");
assert.ok(deep.summary.startsWith("You got 36 min more deep sleep than usual"), deep.summary);
console.log("ok  a better-than-usual night names what was better");

// --- restlessness is a rate ---------------------------------------------
const longNight = buildInsight(usual("2026-09-20", { asleepHours: 9, tosses: 18 }), history);
assert.notEqual(
  longNight.contributors.find((c) => c.key === "restless")?.effect,
  "held-back",
  "18 turns in 9 hours is the usual rate, not restlessness",
);
const restless = buildInsight(usual("2026-09-20", { tosses: 26, thermalScore: 66 }), history);
assert.equal(restless.contributors.find((c) => c.key === "restless")?.effect, "held-back");
console.log("ok  tossing is judged per hour asleep");

// --- guests and the night itself never form the baseline -----------------
const withGuests = [
  ...history,
  ...Array.from({ length: 12 }, (_, i) =>
    usual(`2026-08-${String(i + 1).padStart(2, "0")}`, { restingHeartRate: 72, respiratoryRate: 17, notMe: true }),
  ),
];
const judged = buildInsight(usual("2026-09-20"), withGuests);
assert.equal(judged.baselineNights, 10);
assert.equal(judged.vitalsStatus, "Typical", "guest vitals must not move the usual range");
console.log("ok  only your own nights define your usual");

// --- vitals out of range --------------------------------------------------
const hot = buildInsight(usual("2026-09-20", { restingHeartRate: 58 }), history);
assert.equal(hot.vitals.find((v) => v.key === "restingHeartRate")?.status, "Notably off");
assert.ok(hot.vitalsSummary.includes("higher than usual"));
const relaxed = buildInsight(usual("2026-09-20", { hrv: 90 }), history);
assert.equal(relaxed.vitalsStatus, "Favorable", "higher HRV is good news, not 'off'");
console.log("ok  vitals are read against your own range, and good news is called good");

// --- too few nights to compare -------------------------------------------
const fresh = buildInsight(usual("2026-09-20"), history.slice(0, 3));
assert.ok(fresh.summary.includes("it has 3 so far"), fresh.summary);
assert.equal(fresh.vitalsStatus, null);
console.log("ok  with under five nights it says so instead of comparing");

// --- the headline agrees with the score ---------------------------------
const highButRestless = buildInsight(
  usual("2026-09-20", { tosses: 26, deepHours: 1.5, thermalScore: 89 }),
  history,
);
assert.equal(highButRestless.headline, "More Deep Sleep Than Usual", "a High night leads with what went right");
assert.ok(highButRestless.summary.includes("held it back was more tossing and turning than usual"), highButRestless.summary);
const lowAndRestless = buildInsight(
  usual("2026-09-20", { tosses: 26, deepHours: 1.5, thermalScore: 52 }),
  history,
);
assert.equal(lowAndRestless.headline, "A Restless Night", "a Low night leads with what went wrong");
console.log("ok  the headline never contradicts the score beside it");

// --- TV in bed: latency is from lights out, compared like with like -------
{
  const watched = buildInsight(
    usual("2026-10-06", { sleepLatencyHours: 0.15, screenInBedHours: 0.72 }),
    history, // older nights: latency still included TV time, no screen data
  );
  const latency = watched.contributors.find((c) => c.key === "latency")!;
  assert.equal(latency.label, "Falling asleep after the TV");
  assert.equal(latency.comparison, "counted from when the screen went off",
    "not compared with nights whose latency still included the TV");
  assert.equal(latency.effect, "helped");
  console.log("ok  TV nights are measured from lights out and not compared with TV-inflated ones");
}
