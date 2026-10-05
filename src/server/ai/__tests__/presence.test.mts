import assert from "node:assert";
import {
  EMPTY_BED_GRACE_MIN,
  EMPTY_NIGHTS_BEFORE_WAITING,
  isAway,
  presenceDecision,
} from "../presence";

const base = {
  away: false,
  shutoffEnabled: true,
  stage: "deep",
  minutesSinceBedtime: 120,
  somebodyInBed: false,
  heating: true,
  shutOffForEmptyBed: false,
};

// --- the actual 11-13 Sep 2026 nights: schedule ran, bed was empty --------
assert.equal(presenceDecision(base).kind, "shut-off-empty");
console.log("ok  an empty bed two hours after bedtime stops being heated");

// --- pre-heating must still run: that is the whole point of pre-heating ---
for (const minutes of [-60, -1, 0, EMPTY_BED_GRACE_MIN - 1]) {
  assert.equal(
    presenceDecision({ ...base, stage: "pre-heating", minutesSinceBedtime: minutes }).kind,
    "none",
    `heating must continue ${minutes} min from bedtime`,
  );
}
console.log("ok  the bed still warms before bedtime and through the grace period");

// --- somebody in it: never touched ---------------------------------------
assert.equal(presenceDecision({ ...base, somebodyInBed: true }).kind, "none");
console.log("ok  an occupied bed is never switched off");

// --- arriving late re-arms the schedule ----------------------------------
const rearm = presenceDecision({ ...base, shutOffForEmptyBed: true, somebodyInBed: true });
assert.equal(rearm.kind, "re-arm");
assert.ok(rearm.reason.includes("after all"));
console.log("ok  arriving after the shutoff puts the schedule back");

// --- and is not fought over once already off -----------------------------
// 18 Sep - 3 Oct 2026: "none" here let the stage boundaries switch an empty
// bed back on, and the next tick switched it off again, all night.
for (const stage of ["initial", "deep", "mid", "final", "pre-heating"]) {
  assert.equal(
    presenceDecision({ ...base, stage, shutOffForEmptyBed: true, heating: false }).kind,
    "stay-off",
    `an already-off empty bed stays off through the ${stage} boundary`,
  );
}
assert.equal(
  presenceDecision({ ...base, shutOffForEmptyBed: true, heating: true }).kind,
  "stay-off",
  "somebody switching it on by hand is not fought either",
);
console.log("ok  once off for emptiness, no stage boundary switches it back on");

// --- nobody for two nights: stop pre-heating, wait for a person ----------
const waiting = presenceDecision({
  ...base,
  stage: "pre-heating",
  minutesSinceBedtime: -60,
  heating: false,
  emptyNightsInARow: EMPTY_NIGHTS_BEFORE_WAITING,
});
assert.equal(waiting.kind, "shut-off-empty");
assert.ok(waiting.kind === "shut-off-empty" && waiting.reason.includes("not pre-heating"));
assert.equal(
  presenceDecision({
    ...base,
    stage: "pre-heating",
    minutesSinceBedtime: -60,
    emptyNightsInARow: EMPTY_NIGHTS_BEFORE_WAITING - 1,
  }).kind,
  "none",
  "one empty night is not a pattern: still pre-heat",
);
assert.equal(
  presenceDecision({
    ...base,
    stage: "pre-heating",
    minutesSinceBedtime: -30,
    somebodyInBed: true,
    emptyNightsInARow: 5,
  }).kind,
  "none",
  "somebody already in it: run the night",
);
assert.equal(
  presenceDecision({ ...base, shutoffEnabled: false, emptyNightsInARow: 5 }).kind,
  "none",
  "opting out of the shutoff opts out of waiting too",
);
console.log("ok  after two empty nights the bed waits instead of pre-heating");

// --- outside the cycle this is none of our business ----------------------
assert.equal(
  presenceDecision({ ...base, stage: "outside sleep cycle" }).kind,
  "none",
);
console.log("ok  daytime is left to the ordinary wake-up branch");

// --- opting out -----------------------------------------------------------
assert.equal(presenceDecision({ ...base, shutoffEnabled: false }).kind, "none");
console.log("ok  the shutoff can be switched off");

// --- a stated absence beats every inference ------------------------------
const awayOn = presenceDecision({ ...base, away: true, stage: "outside sleep cycle", somebodyInBed: true });
assert.equal(awayOn.kind, "away", "away applies at any hour, even if the pod thinks someone is there");
assert.equal(presenceDecision({ ...base, away: true, heating: false }).kind, "none", "nothing to do when already off");
console.log("ok  a planned absence overrides the clock and the sensors");

// --- the date entered is the day you are home again ----------------------
assert.equal(isAway("2026-10-04", "2026-09-21"), true);
assert.equal(isAway("2026-10-04", "2026-10-03"), true, "the night before you get back is still away");
assert.equal(isAway("2026-10-04", "2026-10-04"), false, "the night you get home, the bed runs");
assert.equal(isAway(null, "2026-09-14"), false);
assert.equal(isAway(undefined, "2026-09-14"), false);
console.log("ok  the bed is back on the night you said you would be home");
