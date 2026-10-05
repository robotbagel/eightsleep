import assert from "node:assert";
import {
  CAPABILITIES,
  describeRole,
  GUEST_LINK_DEFAULT_DAYS,
  GUEST_LINK_MAX_DAYS,
  hashToken,
  SHARE_ROLES,
  stayExpiry,
  stayWakeDates,
} from "../shareLinks";

// --- a guest can warm the bed and nothing else ----------------------------
const guest = CAPABILITIES.guest;
assert.equal(guest.setTemperature, true, "the entire point of the link");
assert.equal(guest.giveComfortFeedback, true);
assert.equal(
  guest.setStayProfile,
  true,
  "a visitor arriving at four needs to set up the whole night, not nudge a bed that is off",
);
assert.equal(
  guest.editOwnerSchedule,
  false,
  "but never by writing the owner's row, which the autopilot has spent weeks tuning",
);
assert.equal(guest.seeOwnNights, true, "their own night is theirs to read");
assert.equal(guest.seeOwnerHistory, false, "the owner's nights are not");
assert.equal(guest.administer, false, "nor issue further links");
console.log("ok  a guest sets up their own night and reads only their own sleep");

// --- and a guest's nights never teach the owner's loop --------------------
assert.equal(
  guest.nightsAreTheOwners,
  false,
  "a guest's deep sleep is not a verdict on the owner's temperature profile",
);
assert.equal(CAPABILITIES.household.nightsAreTheOwners, true);
console.log("ok  guest nights are excluded from the owner's learning");

// --- household is full control of its OWN side, never of the owner's ------
const household = CAPABILITIES.household;
assert.equal(household.editOwnerSchedule, true, "their side, their stored row");
assert.equal(
  household.setStayProfile,
  false,
  "a resident has no need of an overlay: the schedule they edit IS theirs",
);
assert.equal(household.seeOwnNights, true);
assert.equal(household.seeOwnerHistory, true);
assert.equal(
  household.administer,
  false,
  "issuing links stays with the account holder",
);
console.log("ok  a household link runs its own side but cannot administer");

// --- exactly one way to write a schedule, per role -----------------------
for (const role of SHARE_ROLES) {
  const c = CAPABILITIES[role];
  assert.ok(
    !(c.setStayProfile && c.editOwnerSchedule),
    `${role} must not have two ways to write a schedule`,
  );
}
console.log("ok  each role writes a schedule exactly one way");

// --- no role may administer: that is the owner's cookie alone ------------
for (const role of SHARE_ROLES) {
  assert.equal(
    CAPABILITIES[role].administer,
    false,
    `${role} must never be able to issue or revoke links`,
  );
  assert.ok(describeRole(role).length > 40, `${role} needs a plain description`);
}
console.log("ok  no share link can ever hand out further access");

// --- the stored value must not be the secret -----------------------------
const secret = "abcdefghijklmnopqrstuvwxyz012345";
const stored = hashToken(secret);
assert.notEqual(stored, secret, "a leaked database must not be a leaked bed");
assert.equal(stored.length, 64, "sha-256 hex");
assert.equal(hashToken(secret), stored, "and it must be stable to look up");
assert.notEqual(hashToken(secret + "x"), stored);
console.log("ok  only a hash of the link secret is stored");

// --- a guest link always lapses ------------------------------------------
assert.ok(GUEST_LINK_DEFAULT_DAYS >= 1);
assert.ok(
  GUEST_LINK_DEFAULT_DAYS <= GUEST_LINK_MAX_DAYS,
  "the default must be inside the cap",
);
assert.ok(GUEST_LINK_MAX_DAYS <= 31, "a guest link must not be effectively permanent");
console.log("ok  guest links expire, and cannot be issued open-ended");

// --- a stay covers the nights from its first night, not from issue -------
// 14 Sep 2026: a link made the afternoon before the owner left claimed the
// owner's own last night at home. The stay now starts at `startsOn`.
{
  const issued = new Date("2026-09-14T15:58:00Z");
  const expiresAt = stayExpiry("2026-09-15", 3, issued);
  assert.equal(expiresAt.toISOString(), "2026-09-18T12:00:00.000Z");
  const wakes = stayWakeDates({ startsOn: "2026-09-15", expiresAt, revokedAt: null });
  assert.deepEqual(wakes, ["2026-09-16", "2026-09-17", "2026-09-18"],
    "nights of the 15th, 16th and 17th, woken from on the 16th-18th");
  assert.ok(!wakes.includes("2026-09-15"), "the owner's night before the stay is not the guest's");

  const withdrawnEarly = stayWakeDates({
    startsOn: "2026-09-15",
    expiresAt,
    revokedAt: new Date("2026-09-17T08:00:00Z"),
  });
  assert.deepEqual(withdrawnEarly, ["2026-09-16", "2026-09-17"], "withdrawn the morning after the 2nd night");

  const testedAndWithdrawn = stayWakeDates({
    startsOn: "2026-10-05",
    expiresAt: stayExpiry("2026-10-05", 2, new Date("2026-10-05T10:00:00Z")),
    revokedAt: new Date("2026-10-05T15:00:00Z"),
  });
  assert.deepEqual(testedAndWithdrawn, [], "a link withdrawn before its first night covers nothing");

  assert.deepEqual(
    stayWakeDates({ startsOn: null, expiresAt, revokedAt: null }),
    [],
    "links from before stays existed are left to the old per-night marking",
  );
  console.log("ok  a guest stay covers exactly its own nights");
}
