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

/**
 * Empty nights in a row after which the bed stops pre-heating and waits for
 * somebody instead. Measured 18 Sep - 3 Oct 2026: with nobody home, each side
 * still pre-heated for two hours every evening before the inferred shutoff
 * could fire, because silence an hour past bedtime is the earliest an absence
 * can be inferred. Two empty nights is a pattern; after that the first sign
 * of a person (a session with a human heart rate) re-arms the schedule.
 */
export const EMPTY_NIGHTS_BEFORE_WAITING = 2;

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
  /**
   * How many nights in a row, ending last night, nobody turned up and the
   * side was switched off for emptiness. Optional so older callers and tests
   * keep the plain behaviour.
   */
  emptyNightsInARow?: number;
}

export type PresenceAction =
  | { kind: "away"; reason: string }
  | { kind: "shut-off-empty"; reason: string }
  | { kind: "re-arm"; reason: string }
  /**
   * Already switched off for emptiness and still nobody here: leave the side
   * exactly as it is. Without this the scheduler fell through to its stage
   * boundaries and switched an empty bed back ON at every one of them, which
   * the next tick switched off again: 18 Sep - 3 Oct 2026 show the same
   * on-off pair at every boundary, every night, on both sides.
   */
  | { kind: "stay-off" }
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

  // Off for emptiness and nobody has arrived: hands off until somebody does.
  // Not even a stage boundary may switch it back on.
  if (input.shutOffForEmptyBed && inCycle) return { kind: "stay-off" };

  if (!input.shutoffEnabled || !inCycle) return { kind: "none" };

  // Nobody has slept here for a while: do not pre-heat on the off chance.
  // Fires from the first tick of the cycle, heating or not, so it is logged
  // once and every later tick of the night sees "stay-off".
  const emptyNights = input.emptyNightsInARow ?? 0;
  if (emptyNights >= EMPTY_NIGHTS_BEFORE_WAITING && !input.somebodyInBed) {
    return {
      kind: "shut-off-empty",
      reason: `Nobody has slept here for ${emptyNights} nights, so the bed is not pre-heating. It starts the moment somebody gets in.`,
    };
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

/**
 * Is a planned-away window covering the night now being driven?
 *
 * `backOn` is the date the sleeper is HOME AGAIN, and that night the bed runs.
 * It used to be an inclusive "away until": on 4 Oct 2026 Nathan came home on
 * the date he had entered, found the bed still off for the night, and had to
 * clear the setting by hand at 22:44. People name the day they get back.
 */
export function isAway(
  backOn: string | null | undefined,
  todayKey: string,
): boolean {
  if (!backOn) return false;
  return todayKey < backOn;
}
