import assert from "node:assert";
import { soundBefore, soundNight, wakeUpTimes, type SoundEvent } from "../sound";

const T = (hhmm: string) => Date.parse(`2026-10-06T${hhmm}:00Z`);
const ev = (hhmm: string, kind: string): SoundEvent => ({ at: new Date(T(hhmm)), kind, aboveQuietDb: 20 });

// --- a meow 40 s before a wake-up is its likely cause ----------------------
assert.equal(soundBefore([ev("02:00", "cat_meow")], T("02:00") + 40_000)?.kind, "cat_meow");
assert.equal(soundBefore([ev("02:00", "cat_meow")], T("02:05")), null, "five minutes later it is unrelated");
console.log("ok  a sound counts only in the two minutes before");

// --- a night where the cats woke them --------------------------------------
{
  const night = soundNight(
    [ev("01:10", "cat_meow"), ev("03:20", "thump_thud"), ev("04:40", "cat_meow")],
    T("00:00"),
    T("06:00"),
    [T("01:11"), T("03:21"), T("05:30")],
    [T("01:11"), T("02:00"), T("03:21")],
  );
  assert.ok(night);
  assert.deepEqual(night.counts, { cat_meow: 2, thump_thud: 1 });
  assert.equal(night.wakeUps, 3);
  assert.deepEqual(night.wakeUpsAfterSound.map((w) => w.kind), ["cat_meow", "thump_thud"]);
  assert.equal(night.tossesAfterSound, 2);
  assert.ok(night.chanceShare < 0.05, "three sounds cover a sliver of a six-hour night");
  assert.equal(night.likelyCause, true);
  console.log("ok  wake-ups that follow sounds far above chance are called out");
}

// --- a noisy night proves nothing ------------------------------------------
{
  const constant: SoundEvent[] = [];
  for (let m = 0; m < 360; m += 2) constant.push({ at: new Date(T("00:00") + m * 60_000), kind: "snoring", aboveQuietDb: 8 });
  const night = soundNight(constant, T("00:00"), T("06:00"), [T("01:11"), T("03:21")], []);
  assert.ok(night);
  assert.ok(night.chanceShare > 0.9);
  assert.equal(night.likelyCause, false, "when a sound is always near, it cannot be named the cause");
  console.log("ok  a sound that is there all night is not blamed for the wake-ups");
}

// --- no sounds, nothing to say -----------------------------------------------
assert.equal(soundNight([], T("00:00"), T("06:00"), [T("01:00")], []), null);
console.log("ok  a night without listening reports nothing");

// --- wake-up markers merge like the pod's own count --------------------------
assert.deepEqual(
  wakeUpTimes(
    [["2026-10-06T01:00:00Z", 1], ["2026-10-06T01:04:00Z", 1], ["2026-10-06T03:00:00Z", 1], ["2026-10-06T07:00:00Z", 1]],
    T("00:00"),
    T("06:00"),
  ),
  [T("01:00"), T("03:00")],
);
console.log("ok  wake-ups within ten minutes are one, and outside sleep they do not count");
