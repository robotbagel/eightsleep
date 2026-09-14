import assert from "node:assert";
import { EMPTY_BED_GRACE_MIN, isAway, presenceDecision } from "../presence";

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
assert.equal(
  presenceDecision({ ...base, shutOffForEmptyBed: true, heating: false }).kind,
  "none",
  "an already-off empty bed generates no further commands",
);
console.log("ok  the shutoff fires once, not on every tick");

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

// --- the away window is inclusive of its last night ----------------------
assert.equal(isAway("2026-09-20", "2026-09-14"), true);
assert.equal(isAway("2026-09-20", "2026-09-20"), true, "the last night is still away");
assert.equal(isAway("2026-09-20", "2026-09-21"), false, "and the bed is back the night after");
assert.equal(isAway(null, "2026-09-14"), false);
assert.equal(isAway(undefined, "2026-09-14"), false);
console.log("ok  the away window covers its final night and then releases");
