import assert from "node:assert";
import {
  CAPABILITIES,
  describeRole,
  GUEST_LINK_DEFAULT_DAYS,
  GUEST_LINK_MAX_DAYS,
  hashToken,
  SHARE_ROLES,
} from "../shareLinks";

// --- a guest can warm the bed and nothing else ----------------------------
const guest = CAPABILITIES.guest;
assert.equal(guest.setTemperature, true, "the entire point of the link");
assert.equal(guest.giveComfortFeedback, true);
assert.equal(guest.editSchedule, false, "a visitor must not redefine the bed");
assert.equal(guest.seeHistory, false, "nor read the owner's sleep history");
assert.equal(guest.administer, false, "nor issue further links");
console.log("ok  a guest link can change tonight and nothing else");

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
assert.equal(household.editSchedule, true);
assert.equal(household.seeHistory, true);
assert.equal(
  household.administer,
  false,
  "issuing links stays with the account holder",
);
console.log("ok  a household link runs its own side but cannot administer");

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
