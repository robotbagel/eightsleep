import assert from "node:assert";
import { inBedAt, screenNight, type ScreenEvent } from "../screen";

const t = (hhmm: string, day = "2026-10-05") => new Date(`${day}T${hhmm}:00Z`);
const ev = (hhmm: string, state: "on" | "off", day?: string): ScreenEvent => ({ at: t(hhmm, day), state });

// --- the household's evening: bed at 21:05, two episodes, off, asleep ------
{
  const night = screenNight(
    [ev("21:02", "on"), ev("21:48", "off")],
    t("21:05"),
    t("21:57"),
  );
  assert.ok(night);
  assert.equal(night.inBedMinutes, 43, "watching in bed counts from getting in");
  assert.equal(Math.round(night.latencyHours * 60), 9, "latency starts at lights out, not at getting in");
  assert.equal(night.fellAsleepWatching, false);
  assert.equal(night.offAt, "2026-10-05T21:48:00.000Z");
  console.log("ok  the 40 minutes of TV are not counted as trying to sleep");
}

// --- no TV: the pod's own latency stands ---------------------------------
assert.equal(screenNight([ev("18:00", "on"), ev("19:30", "off")], t("21:05"), t("21:40")), null);
assert.equal(screenNight([], t("21:05"), t("21:40")), null);
console.log("ok  a night without TV in bed changes nothing");

// --- dozed off with it on -------------------------------------------------
{
  const night = screenNight([ev("21:00", "on"), ev("22:10", "off")], t("21:05"), t("21:50"));
  assert.ok(night && night.fellAsleepWatching);
  assert.equal(night.latencyHours, 0);
  assert.equal(night.inBedMinutes, 45, "only the time before sleep counts as screen time in bed");
  console.log("ok  falling asleep with the screen on reads as no latency at all");
}

// --- left on all night (no off before the data ends) -----------------------
{
  const night = screenNight([ev("21:00", "on")], t("21:05"), t("21:50"));
  assert.ok(night && night.fellAsleepWatching && night.offAt === null);
  console.log("ok  a screen still on is handled, not crashed on");
}

// --- switched on before the evening window, off in bed ----------------------
{
  const night = screenNight([ev("20:30", "on"), ev("21:30", "off")], t("21:05"), t("21:45"));
  assert.ok(night);
  assert.equal(night.inBedMinutes, 25);
  assert.equal(Math.round(night.latencyHours * 60), 15);
  console.log("ok  a screen already on when you got in counts from getting in");
}

// --- off, then on again briefly before sleep: the LAST off is lights out ----
{
  const night = screenNight(
    [ev("21:00", "on"), ev("21:40", "off"), ev("21:43", "on"), ev("21:46", "off")],
    t("21:05"),
    t("21:55"),
  );
  assert.ok(night);
  assert.equal(night.offAt, "2026-10-05T21:46:00.000Z");
  assert.equal(night.inBedMinutes, 38);
  console.log("ok  lights out is the last time the screen went off before sleep");
}

// --- getting into bed ------------------------------------------------------
assert.equal(
  inBedAt({ ts: "2026-10-05T21:05:00Z", sleepStart: "2026-10-05T21:57:00Z" })?.toISOString(),
  "2026-10-05T21:05:00.000Z",
);
assert.equal(
  inBedAt({ sleepStart: "2026-10-05T21:57:00Z", stageSummary: { awakeBeforeSleepDuration: 3120 } })?.toISOString(),
  "2026-10-05T21:05:00.000Z",
  "without a session start, sleep start minus the pod's latency",
);
console.log("ok  getting into bed comes from the session, with a fallback");

// --- a session that opened before the pod could read anyone -----------------
// 5-6 Oct 2026, Laurence's side: someone registered at 23:30 local but no
// heart rate until 02:10. In bed counts from the first vitals.
assert.equal(
  inBedAt({
    ts: "2026-10-05T21:30:00Z",
    sleepStart: "2026-10-06T00:25:00Z",
    timeseries: { heartRate: [["2026-10-06T00:10:00Z", 63]], hrv: [] },
  })?.toISOString(),
  "2026-10-06T00:10:00.000Z",
);
assert.equal(
  inBedAt({
    ts: "2026-10-05T21:25:00Z",
    sleepStart: "2026-10-05T21:41:30Z",
    timeseries: { heartRate: [["2026-10-05T21:27:00Z", 60]] },
  })?.toISOString(),
  "2026-10-05T21:25:00.000Z",
  "a few minutes before the first reading is normal and changes nothing",
);
console.log("ok  time the pod could not read anyone is not time in bed");
