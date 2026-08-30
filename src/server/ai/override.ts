// override.ts
// Noticing when a person reaches for the dial themselves.
//
// The scheduling cron ran `if (heatingStatus.heatingLevel !== targetLevel)
// setHeatingLevel(targetLevel)` every ten minutes. That is correct for holding
// a schedule and catastrophic as a response to a human: someone who wakes up
// cold, turns the bed up in the Eight app and goes back to sleep had that
// undone within ten minutes, silently, with no record that it ever happened —
// and the morning pass then read a night of undisturbed sleep at ITS OWN
// setting and concluded the setting was fine.
//
// A hand on the dial at 03:00 is the strongest signal this system can
// receive. It is not noise to be corrected; it is the answer to the question
// the whole loop exists to ask. So it is treated as two things at once:
//
//   1. an instruction for the REST OF THIS NIGHT — the difference is carried
//      as a live offset, so every later stage keeps its shape but sits where
//      the person put it, and the cron stops fighting them;
//   2. a comfort report for the MORNING — recorded as sleepFeedback in the
//      same form the daily prompt writes, so the base profile actually moves
//      and the correction does not have to be made again tomorrow.
import { and, desc, eq } from "drizzle-orm";
import { db } from "~/server/db";
import {
  aiLiveAdjustments,
  sleepFeedback,
  temperatureEvents,
} from "~/server/db/schema";
import { rawToCelsius } from "~/lib/temperature";
import { nightKeyFor } from "./time";
import { shiftDate } from "./history";

/**
 * Below this the difference is rounding between the level scale and °C, not a
 * person. One level step is ~0.15°C, so this is a two-step deliberate move.
 */
export const OVERRIDE_MIN_C = 0.25;

// ---------------------------------------------------------------------------
// Ghost schedules. Eight's cloud can carry a leftover temperature schedule
// the official app no longer shows ("Bedtime: Not set") yet still fires
// nightly — one was found armed at 23:00:28 setting level -40 (22.2°C). It
// cannot be disabled through the temperature PUT (returns 200, keeps the
// schedule enabled, and resets timeBased.level as a side effect). So the
// cron recognises its signature instead: a target change to EXACTLY the
// schedule's level within a tick's slack of its firing time is the robot,
// not a person — reassert our schedule, never record it as a hand.
// ---------------------------------------------------------------------------

/** One tick's worth of slack either side of a schedule's firing time. */
export const GHOST_WINDOW_MIN = 12;

export interface GhostScheduleLike {
  /** "HH:MM:SS" in the user's local time. */
  time: string;
  /** The raw level the schedule sets. */
  level: number;
}

/** Minutes between a wall-clock Date and an "HH:MM:SS" clock time, across
 *  the midnight wrap. */
export function minutesFromClockTime(current: Date, clock: string): number {
  const [h, m] = clock.split(":").map(Number);
  const clockMinutes = (h ?? 0) * 60 + (m ?? 0);
  const nowMinutes = current.getHours() * 60 + current.getMinutes();
  let diff = Math.abs(nowMinutes - clockMinutes);
  if (diff > 12 * 60) diff = 24 * 60 - diff;
  return diff;
}

export function matchGhostSchedule<T extends GhostScheduleLike>(
  ghosts: T[],
  observedLevel: number,
  userNow: Date,
): T | null {
  return (
    ghosts.find(
      (g) =>
        g.level === observedLevel &&
        minutesFromClockTime(userNow, g.time) <= GHOST_WINDOW_MIN,
    ) ?? null
  );
}

/** Levels the pod can be left at that mean "off", not "set to freezing". */
const OFF_LEVEL = 0;

export interface OverrideResult {
  /** Tenths of °C the human moved it, signed. */
  deltaTenthsC: number;
  /** The live offset now in force for the rest of the night. */
  newOffsetTenthsC: number;
  direction: "warmer" | "cooler";
}

const STAGE_TO_WHEN: Record<string, string> = {
  initial: "falling_asleep",
  // "deep" is not a choice the prompt offers, but the schedule knows which
  // stage was running, so the true stage is recorded rather than rounded to
  // the nearest thing a person could have picked.
  deep: "deep",
  mid: "middle",
  final: "morning",
  "pre-heating": "falling_asleep",
};

/**
 * Compare what the pod is actually set to against the last level THIS app
 * wrote. Anything else moved it.
 *
 * Returns null when nothing moved, when we have not written a level tonight
 * yet (so there is nothing to compare against), or when the move is too small
 * to be deliberate.
 */
export async function detectManualOverride(input: {
  email: string;
  timezone: string;
  wakeupTime: string;
  now: Date;
  stage: string;
  observedLevel: number;
  currentOffsetTenthsC: number;
  /** The CURRENT stage's scheduled level, before any offset. The person
   *  states an ABSOLUTE level; the offset carried forward is derived from
   *  it (observed − stage base), never accumulated incrementally — an
   *  incremental delta re-applied to the base lands wherever the ledger
   *  drifted, which is how a hand-set 25°C became a written 23.3°C. */
  stageBaseLevel: number;
}): Promise<OverrideResult | null> {
  const night = nightKeyFor(input.now, input.timezone, input.wakeupTime);

  const lastWritten = await db.query.temperatureEvents.findFirst({
    where: and(
      eq(temperatureEvents.email, input.email),
      eq(temperatureEvents.night, night),
    ),
    orderBy: desc(temperatureEvents.id),
  });
  // No level of ours to compare against — the first write of the night is not
  // an override.
  if (!lastWritten || lastWritten.level == null) return null;
  // A previous manual row is a valid baseline like any other: the person may
  // reach for the dial twice in a row, and the second move must be followed
  // too. (An unchanged target is caught by the equality check below; the old
  // "last row is manual → never a new override" guard silently discarded
  // every consecutive adjustment until a scheduled write happened to land.)
  if (input.observedLevel === lastWritten.level) return null;
  // "Off" is the pod being off, not someone asking for 13°C.
  if (input.observedLevel === OFF_LEVEL && lastWritten.level !== OFF_LEVEL) {
    return null;
  }

  const deltaC =
    rawToCelsius(input.observedLevel) - rawToCelsius(lastWritten.level);
  if (Math.abs(deltaC) < OVERRIDE_MIN_C) return null;

  const deltaTenthsC = Math.sign(deltaC) * Math.round(Math.abs(deltaC) * 10);
  // Absolute, not incremental: the offset is exactly what makes
  // stage base + offset reproduce the level the person chose.
  const offsetC =
    rawToCelsius(input.observedLevel) - rawToCelsius(input.stageBaseLevel);
  const newOffsetTenthsC =
    Math.sign(offsetC) * Math.round(Math.abs(offsetC) * 10);
  const direction: "warmer" | "cooler" = deltaTenthsC > 0 ? "warmer" : "cooler";

  await db.insert(temperatureEvents).values({
    email: input.email,
    night,
    at: input.now,
    stage: input.stage,
    level: input.observedLevel,
    source: "manual",
    note: `You set the bed ${Math.abs(deltaTenthsC) / 10}°C ${direction} yourself. Held for the rest of the night.`,
  });

  // Carry it forward: every later stage keeps its shape but sits where they
  // put it, and the ten-minute schedule stops undoing them.
  await db.insert(aiLiveAdjustments).values({
    email: input.email,
    night,
    stage: input.stage,
    offsetDelta: deltaTenthsC,
    newOffset: newOffsetTenthsC,
    appliedLevel: input.observedLevel,
    reason: `Manual override during the ${input.stage} stage — ${Math.abs(deltaTenthsC) / 10}°C ${direction}. Following it rather than correcting it.`,
  });

  // And tell the morning. The comfort prompt keys feedback by the WAKE date;
  // the night key is the date the night STARTED, so wake date = night + 1.
  // Deriving it from the clock instead put an override made before midnight
  // (23:00) under YESTERDAY's wake date — a report about the wrong night.
  const feedbackNight = shiftDate(night, 1);
  const existing = await db.query.sleepFeedback.findFirst({
    where: and(
      eq(sleepFeedback.email, input.email),
      eq(sleepFeedback.night, feedbackNight),
    ),
  });
  // Somebody answering the prompt outranks something inferred from the dial,
  // so an existing report for tonight is never overwritten.
  if (!existing) {
    await db.insert(sleepFeedback).values({
      email: input.email,
      night: feedbackNight,
      felt: direction === "warmer" ? "too_cold" : "too_hot",
      whenFelt: STAGE_TO_WHEN[input.stage] ?? "not_sure",
      note: "Recorded from a hand adjustment made during the night.",
    });
  }

  return { deltaTenthsC, newOffsetTenthsC, direction };
}
