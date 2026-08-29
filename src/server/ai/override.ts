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

/**
 * Below this the difference is rounding between the level scale and °C, not a
 * person. One level step is ~0.15°C, so this is a two-step deliberate move.
 */
export const OVERRIDE_MIN_C = 0.25;

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
  deep: "middle",
  mid: "middle",
  final: "morning",
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
  // Our own record of a previous override is not a new one.
  if (lastWritten.source === "manual") return null;
  if (input.observedLevel === lastWritten.level) return null;
  // "Off" is the pod being off, not someone asking for 13°C.
  if (input.observedLevel === OFF_LEVEL && lastWritten.level !== OFF_LEVEL) {
    return null;
  }

  const deltaC =
    rawToCelsius(input.observedLevel) - rawToCelsius(lastWritten.level);
  if (Math.abs(deltaC) < OVERRIDE_MIN_C) return null;

  const deltaTenthsC = Math.sign(deltaC) * Math.round(Math.abs(deltaC) * 10);
  const newOffsetTenthsC = input.currentOffsetTenthsC + deltaTenthsC;
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

  // And tell the morning. Keyed on the local calendar date, which is the wake
  // date — the same key the comfort prompt uses, so the two cannot disagree.
  const feedbackNight = input.now.toLocaleDateString("en-CA", {
    timeZone: input.timezone,
  });
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
