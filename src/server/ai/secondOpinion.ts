// secondOpinion.ts
// The Apple Watch's reading of a night the pod also recorded.
//
// Two sensors, two opinions. Where they agree the pod's night is confirmed;
// where they differ the difference itself is the finding — the 2 Sep 2026
// night read 56 min awake on the pod and 11 min on the Watch, and nobody
// would have known without both side by side. Pure functions, no I/O.

export interface SourceReading {
  score: number | null;
  asleepHours: number | null;
  awakeHours: number | null;
  wakeCount: number | null;
  deepHours: number | null;
  remHours: number | null;
}

export interface SecondOpinion extends SourceReading {
  /** Plain-language lines, one per figure the two sensors disagree on. */
  disagreements: string[];
}

/** Sleep duration gap that counts as a disagreement, not sensor noise. */
export const ASLEEP_DISAGREE_MIN = 45;
/** Awake-time gap that counts as a disagreement. */
export const AWAKE_DISAGREE_MIN = 20;
/** Score gap that counts as a disagreement. */
export const SCORE_DISAGREE_PTS = 10;

function fmtHours(hours: number): string {
  const total = Math.round(hours * 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}

export function compareSources(
  pod: SourceReading,
  watch: SourceReading,
): SecondOpinion {
  const disagreements: string[] = [];

  if (pod.asleepHours != null && watch.asleepHours != null) {
    const gap = Math.abs(pod.asleepHours - watch.asleepHours) * 60;
    if (gap >= ASLEEP_DISAGREE_MIN) {
      disagreements.push(
        `Asleep: pod ${fmtHours(pod.asleepHours)}, Watch ${fmtHours(watch.asleepHours)}.`,
      );
    }
  }
  if (pod.awakeHours != null && watch.awakeHours != null) {
    const gap = Math.abs(pod.awakeHours - watch.awakeHours) * 60;
    if (gap >= AWAKE_DISAGREE_MIN) {
      disagreements.push(
        `Awake mid-night: pod ${fmtHours(pod.awakeHours)}, Watch ${fmtHours(watch.awakeHours)}.`,
      );
    }
  }
  if (pod.score != null && watch.score != null) {
    if (Math.abs(pod.score - watch.score) >= SCORE_DISAGREE_PTS) {
      disagreements.push(`Score: pod ${pod.score}, Watch ${watch.score}.`);
    }
  }

  return { ...watch, disagreements };
}
