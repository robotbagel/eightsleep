import assert from "node:assert";
import {
  DEVIATION_THRESHOLD,
  identityCheck,
  MIN_BASELINE_NIGHTS,
  robustBaseline,
  type VitalsNight,
} from "../identity";

// Real measured nights from the two sleepers on this deployment (2026-09-14).
const OWNER: VitalsNight[] = [
  { restingHeartRate: 43.7, hrv: 101.2, respiratoryRate: 15.9 },
  { restingHeartRate: 44.7, hrv: 82.8, respiratoryRate: 16.1 },
  { restingHeartRate: 45.3, hrv: 89.5, respiratoryRate: 15.5 },
  { restingHeartRate: 45.3, hrv: 79.0, respiratoryRate: 15.3 },
  { restingHeartRate: 44.0, hrv: 94.5, respiratoryRate: 16.1 },
  { restingHeartRate: 42.7, hrv: 103.3, respiratoryRate: 15.7 },
  { restingHeartRate: 44.0, hrv: 101.5, respiratoryRate: 15.7 },
  { restingHeartRate: 43.7, hrv: 83.0, respiratoryRate: 15.4 },
  { restingHeartRate: 48.0, hrv: 77.1, respiratoryRate: 15.5 },
];
// The OTHER real person, measured the same way.
const GUEST: VitalsNight[] = [
  { restingHeartRate: 59.0, hrv: 30.3, respiratoryRate: 13.8 },
  { restingHeartRate: 56.7, hrv: 37.1, respiratoryRate: 14.3 },
  { restingHeartRate: 63.0, hrv: 22.7, respiratoryRate: 13.1 },
];
// The owner's own worst night: late, short, alcohol-shaped. Heart data looks
// like a different person; breathing does not.
const OWN_BAD_NIGHT: VitalsNight = {
  restingHeartRate: 54.3,
  hrv: 55.2,
  respiratoryRate: 15.8,
};

const baseline = robustBaseline(OWNER);

// --- every real guest night is caught -------------------------------------
for (const night of GUEST) {
  const verdict = identityCheck(night, baseline);
  assert.ok(
    verdict.someoneElse,
    `guest night ${JSON.stringify(night)} not flagged: ${verdict.reason}`,
  );
}
console.log("ok  every night of the other person is flagged");

// --- no night of the owner's own is ever flagged --------------------------
for (const night of [...OWNER, OWN_BAD_NIGHT]) {
  const verdict = identityCheck(night, baseline);
  assert.ok(
    !verdict.someoneElse,
    `own night ${JSON.stringify(night)} wrongly flagged: ${verdict.reason}`,
  );
}
console.log("ok  no night of the owner's own is flagged");

// --- the owner's bad night is explained, not dismissed --------------------
const bad = identityCheck(OWN_BAD_NIGHT, baseline);
assert.ok(bad.reason.includes("unusual night of your own"), bad.reason);
const badHr = bad.deviations.find((d) => d.metric === "resting heart rate")!;
assert.ok(badHr.mads >= DEVIATION_THRESHOLD, "its heart rate really is out of character");
const badBreath = bad.deviations.find((d) => d.metric === "breathing rate")!;
assert.ok(badBreath.mads < 1, "while its breathing rate is dead normal");
console.log("ok  an unusual own night reads as unusual, not as a stranger");

// --- margin on both sides --------------------------------------------------
const guestMargin = Math.min(
  ...GUEST.map((n) => identityCheck(n, baseline).deviations.find((d) => d.metric === "breathing rate")!.mads),
);
const ownMargin = Math.max(
  ...[...OWNER, OWN_BAD_NIGHT].map(
    (n) => identityCheck(n, baseline).deviations.find((d) => d.metric === "breathing rate")!.mads,
  ),
);
// The populations themselves, before any threshold: this is the fact the
// rule rests on, so it is asserted directly. If a future night narrows this
// gap the test fails here, where the cause is obvious, rather than as a
// mysterious misclassification later.
assert.ok(guestMargin >= 4.5, `the other person should sit >= 4.5 MADs out, got ${guestMargin.toFixed(2)}`);
assert.ok(ownMargin <= 1.5, `own nights should stay <= 1.5 MADs out, got ${ownMargin.toFixed(2)}`);
assert.ok(
  ownMargin < DEVIATION_THRESHOLD && DEVIATION_THRESHOLD < guestMargin,
  `the threshold must sit between the two populations (${ownMargin.toFixed(2)} < ${DEVIATION_THRESHOLD} < ${guestMargin.toFixed(2)})`,
);
assert.ok(guestMargin / DEVIATION_THRESHOLD >= 1.5, "at least 1.5x margin above");
assert.ok(DEVIATION_THRESHOLD / ownMargin >= 1.5, "at least 1.5x margin below");
console.log(
  `ok  breathing rate separates them: guests >= ${guestMargin.toFixed(1)} MADs, own nights <= ${ownMargin.toFixed(1)}`,
);

// --- a thin baseline never accuses ----------------------------------------
const thin = robustBaseline(OWNER.slice(0, MIN_BASELINE_NIGHTS - 1));
assert.equal(identityCheck(GUEST[0]!, thin).someoneElse, false);
assert.ok(identityCheck(GUEST[0]!, thin).reason.includes("too few"));
console.log("ok  too few own nights means no verdict, not a wrong one");

// --- a guest already in the baseline cannot hide the next one -------------
const poisoned = robustBaseline([...OWNER, ...GUEST]);
assert.ok(
  identityCheck(GUEST[0]!, poisoned).someoneElse,
  "median/MAD must not be dragged toward a guest already in the window",
);
console.log("ok  a robust baseline survives guest nights inside it");

// --- missing vitals are not evidence --------------------------------------
const blank = identityCheck(
  { restingHeartRate: null, hrv: null, respiratoryRate: null },
  baseline,
);
assert.equal(blank.someoneElse, false);
assert.equal(blank.deviations.length, 0);
console.log("ok  a night with no vitals is never accused");
