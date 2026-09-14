// presence.ts
// "Is there anybody in this bed tonight?"
//
// The scheduler runs on the clock. It pre-heats an hour before bedtime,
// steps through four stages and turns off at wake-up, and until now it did
// all of that whether or not a person was ever in the bed. On 11-12 and
// 12-13 September 2026 nobody slept in either bed; the pod recorded no
// session at all, and the schedule still ran in full both nights — four
// temperature changes each, water held at 26-27.3 C from 20:40 to 05:30.
// Nine hours of heating an empty bed, twice, with nothing anywhere saying so.
//
// Two separate things are wanted, and they are deliberately kept apart:
//
//   1. A PLANNED absence. The sleeper knows they are away, says so, and the
//      bed should do nothing at all. No inference involved.
//   2. An UNPLANNED empty bed. Nobody said anything and nobody turned up.
//      Inferred, so it must be cautious and always reversible.
//
// The evidence for (2) is the same evidence the live tuner already trusts
// before it dares change a temperature: a fresh pod session whose heart rate
// looks like a sleeping adult. Nothing new is being believed here.
//
// Turning the side off does NOT blind the pod: it records sessions whether
// or not our scheduler drives it (proven by every night before 23 August
// 2026, when nothing drove the bed and full sessions were still recorded).
// So a bed switched off for emptiness still notices somebody getting into
// it, and the schedule is re-established on the next tick.
//
// Pure functions: no I/O and no clock of their own, so every branch is
// testable and the cron keeps all the side effects.

/** Minutes after bedtime before an absence is inferred from silence. */
export const EMPTY_BED_GRACE_MIN = 60;

export interface PresenceInput {
  /** Is a planned-away window active for tonight? */
  away: boolean;
  /** Has the sleeper enabled the empty-bed shutoff? */
  shutoffEnabled: boolean;
  /** Where the schedule thinks we are. */
  stage: string;
  /** Minutes since bedtime; negative before it (pre-heating). */
  minutesSinceBedtime: number;
  /**
   * A fresh pod session with a credible human heart rate — the same test the
   * live tuner uses. Null when the pod reported nothing at all.
   */
  somebodyInBed: boolean;
  /** Is the side currently heating? */
  heating: boolean;
  /** Did we already switch the side off for emptiness tonight? */
  shutOffForEmptyBed: boolean;
}

export type PresenceAction =
  | { kind: "away"; reason: string }
  | { kind: "shut-off-empty"; reason: string }
  | { kind: "re-arm"; reason: string }
  | { kind: "none" };

export function presenceDecision(input: PresenceInput): PresenceAction {
  // A stated absence beats every inference, and applies at every hour.
  if (input.away) {
    return input.heating
      ? {
          kind: "away",
          reason: "Away until the date you set, so the bed stays off.",
        }
      : { kind: "none" };
  }

  const inCycle = input.stage !== "outside sleep cycle";

  // Somebody is here after we had given up on them: put the schedule back.
  // This is what makes the shutoff safe to be wrong about — arriving late
  // costs one tick of a cold bed, not the night.
  if (input.shutOffForEmptyBed && input.somebodyInBed && inCycle) {
    return {
      kind: "re-arm",
      reason: "Somebody got into the bed after all — the schedule is back on.",
    };
  }

  if (!input.shutoffEnabled || !inCycle || input.shutOffForEmptyBed) {
    return { kind: "none" };
  }

  // Before bedtime the bed is SUPPOSED to be empty: pre-heating exists so it
  // is warm on arrival. Only silence well past bedtime means nobody is
  // coming.
  if (input.minutesSinceBedtime < EMPTY_BED_GRACE_MIN) return { kind: "none" };
  if (input.somebodyInBed) return { kind: "none" };
  if (!input.heating) return { kind: "none" };

  const hours = Math.round(input.minutesSinceBedtime / 60);
  return {
    kind: "shut-off-empty",
    reason: `No one has been in the bed ${hours === 1 ? "an hour" : `${hours} hours`} after bedtime, so the heating is off until somebody is.`,
  };
}

/** Is a planned-away window covering the night now being driven? */
export function isAway(
  awayUntil: string | null | undefined,
  todayKey: string,
): boolean {
  if (!awayUntil) return false;
  return todayKey <= awayUntil;
}
