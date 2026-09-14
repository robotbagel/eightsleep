import assert from "node:assert";
import { holdFromRecommendations, type HoldRecord } from "../advisor";
import { MIN_HOLD_NIGHTS } from "../control";

// A change to the mid stage, applied on `forDate`. Everything else steady.
const midChange = (forDate: string, from: number, to: number): HoldRecord => ({
  forDate,
  previousInitialLevel: 10,
  recommendedInitialLevel: 10,
  previousDeepLevel: 0,
  recommendedDeepLevel: 0,
  previousMidLevel: from,
  recommendedMidLevel: to,
  previousFinalLevel: 5,
  recommendedFinalLevel: 5,
});

// --- THE 11-13 SEPTEMBER 2026 REGRESSION ---------------------------------
// A change was applied on the 11th. Nobody slept in the bed on the nights of
// the 11th-12th or 12th-13th, so the pod recorded nothing. On the morning of
// the 13th the old calendar arithmetic said "two days have passed, the hold
// is over" and let the loop move the profile again on a night it had already
// judged. It must now say the change has been tested zero times.
const recs = [midChange("2026-09-11", 20, 16)];
const noNightsMeasured: string[] = [];
const stale = holdFromRecommendations(recs, noNightsMeasured, "2026-09-13");
assert.equal(stale.heldNights, 0, "no measured night means nothing has been tested");
assert.ok(stale.locked.includes("mid"), "and the stage stays locked");
console.log("ok  days passing while the bed is empty do not count as nights tested");

// The same two days, with two nights actually slept: now it IS tested.
const slept = holdFromRecommendations(recs, ["2026-09-12", "2026-09-13"], "2026-09-13");
assert.equal(slept.heldNights, 2);
assert.ok(!slept.locked.includes("mid"), "two measured nights release the lock");
console.log("ok  two measured nights do count, and release the hold");

// One night slept, one night away: half-tested, still locked.
const partial = holdFromRecommendations(recs, ["2026-09-12"], "2026-09-13");
assert.equal(partial.heldNights, 1);
assert.ok(partial.locked.includes("mid"), "one night is not enough to judge a change");
console.log("ok  a single measured night holds the experiment open");

// --- the night a change first governs ------------------------------------
// A change made on D governs the night woken from on D+1, so a night woken
// from on D itself was slept BEFORE the change and cannot have tested it.
const sameDay = holdFromRecommendations(recs, ["2026-09-11"], "2026-09-13");
assert.equal(sameDay.heldNights, 0, "the night before the change does not test it");
assert.equal(sameDay.lastChangeNight, "2026-09-12", "the change first ran on the 12th");
console.log("ok  a night slept before the change does not test it");

// --- direction is remembered, newest first -------------------------------
const cooled = holdFromRecommendations([midChange("2026-09-12", 20, 14)], [], "2026-09-13");
assert.equal(cooled.lockDirection.mid, "cooler");
const warmed = holdFromRecommendations([midChange("2026-09-12", 14, 20)], [], "2026-09-13");
assert.equal(warmed.lockDirection.mid, "warmer");
console.log("ok  the direction of the held change is recorded");

// --- no changes at all ----------------------------------------------------
const never = holdFromRecommendations([], ["2026-09-12"], "2026-09-13");
assert.equal(never.heldNights, 99, "never changed reads as held forever");
assert.equal(never.locked.length, 0);
assert.equal(never.lastChangeNight, null);
console.log("ok  a profile that was never changed is not under measurement");

// --- a long-settled change is released ------------------------------------
const settled = holdFromRecommendations(
  [midChange("2026-09-01", 20, 16)],
  ["2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05"],
  "2026-09-13",
);
assert.ok(settled.heldNights > MIN_HOLD_NIGHTS);
assert.equal(settled.locked.length, 0);
console.log("ok  an old, well-measured change is no longer locked");

// --- today's own row is ignored -------------------------------------------
const todays = holdFromRecommendations([midChange("2026-09-13", 20, 16)], [], "2026-09-13");
assert.equal(todays.heldNights, 99, "the assessment being written now cannot lock itself");
console.log("ok  today's own recommendation does not lock today's decision");
