// identity.ts
// "Is this night actually the person whose bed this is?"
//
// The pod scores whoever is lying on it. A guest in the bed produces a full,
// perfectly valid session under the account owner's id and side, and every
// downstream part of this system then treats it as evidence about the OWNER:
// it enters the experiment ledger, it credits or blames whatever profile was
// loaded, and any live nudge fired for the guest's comfort becomes live
// pressure that folds into the owner's base temperatures after two nights.
// A weekend of visitors could permanently retune a bed for someone who does
// not sleep in it.
//
// Nocturnal vitals are strongly person-specific, so the night carries the
// answer. Measured on this deployment's two real sleepers over ~10 nights
// each (2026-09-14), they do not overlap at all:
//
//            resting HR        HRV            respiratory rate
//   owner A  44.4 ± 0.8       86.2 ± 8.7     15.71 ± 0.21   (15.3–16.1)
//   owner B  59.0 ± 1.0       30.3 ± 3.5     13.77 ± 0.16   (13.1–14.3)
//
// Respiratory rate is the sharpest and the most stable within a person: a
// ~2/min gap between these two, against a within-person spread under
// 0.8/min. Resting HR and HRV separate them just as clearly BUT move a lot
// within one person — a late night with alcohol pushed owner A to 54.3 bpm
// and 55.2 ms HRV (2026-09-06), which is most of the way to owner B while
// the respiratory rate never budged (15.8).
//
// So the test REQUIRES the respiratory rate to be out of character, plus at
// least one of resting HR / HRV. Measured on those two populations the
// breathing rate alone separates them cleanly: every night of the other
// person sits at least 4.6 MADs from owner A's median, while owner A's own
// widest night reaches 1.4. DEVIATION_THRESHOLD is placed between the two,
// with about 1.8x of room on each side.
//
// Pure functions: no I/O, no dates, so the rule can be tested directly.

export interface VitalsNight {
  restingHeartRate: number | null;
  hrv: number | null;
  respiratoryRate: number | null;
}

export interface Baseline {
  restingHeartRate: Stat | null;
  hrv: Stat | null;
  respiratoryRate: Stat | null;
  nights: number;
}

export interface Stat {
  median: number;
  /** Median absolute deviation, floored — see FLOOR. */
  mad: number;
}

/**
 * Minimum MAD per metric, in the metric's own units. A sleeper with an
 * unusually regular week produces a MAD near zero, and without a floor every
 * ordinary night after it would read as hundreds of deviations. These floors
 * are the smallest spread worth treating as normal variation.
 */
export const FLOOR = {
  restingHeartRate: 1.5,
  hrv: 6,
  respiratoryRate: 0.3,
} as const;

/**
 * Deviations (in MADs) beyond which a metric is "out of character". Set from
 * the measured gap between the two real sleepers (see the table above), not
 * from a statistical convention: their nights start at 4.6 MADs of breathing
 * rate, the owner's own nights stop at 1.4, and 2.5 is the midpoint in
 * ratio terms.
 */
export const DEVIATION_THRESHOLD = 2.5;

/** Own-nights needed before the baseline is trustworthy enough to judge. */
export const MIN_BASELINE_NIGHTS = 5;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

function statFor(values: number[], floor: number): Stat | null {
  if (values.length === 0) return null;
  const m = median(values);
  return { median: m, mad: Math.max(median(values.map((v) => Math.abs(v - m))), floor) };
}

/**
 * The owner's own vital signs, as a robust centre and spread. Median and MAD
 * rather than mean and standard deviation precisely because the input may
 * already contain a guest night or two — one wild value must not drag the
 * baseline toward itself and hide the next one.
 */
export function robustBaseline(nights: VitalsNight[]): Baseline {
  const pick = (key: keyof VitalsNight) =>
    nights.map((n) => n[key]).filter((v): v is number => v != null);
  return {
    restingHeartRate: statFor(pick("restingHeartRate"), FLOOR.restingHeartRate),
    hrv: statFor(pick("hrv"), FLOOR.hrv),
    respiratoryRate: statFor(pick("respiratoryRate"), FLOOR.respiratoryRate),
    nights: nights.length,
  };
}

export interface IdentityVerdict {
  /** True only when the evidence says this is someone else. */
  someoneElse: boolean;
  /** How far each metric sits from the owner's own centre, in MADs. */
  deviations: { metric: string; value: number; median: number; mads: number }[];
  /** One sentence for the app and the operator log. */
  reason: string;
}

export function identityCheck(
  night: VitalsNight,
  baseline: Baseline,
): IdentityVerdict {
  const deviations: IdentityVerdict["deviations"] = [];
  const add = (metric: keyof VitalsNight, label: string) => {
    const stat = baseline[metric];
    const value = night[metric];
    if (stat == null || value == null) return;
    deviations.push({
      metric: label,
      value,
      median: stat.median,
      mads: Math.abs(value - stat.median) / stat.mad,
    });
  };
  add("respiratoryRate", "breathing rate");
  add("restingHeartRate", "resting heart rate");
  add("hrv", "HRV");

  const out = (label: string) =>
    deviations.some((d) => d.metric === label && d.mads >= DEVIATION_THRESHOLD);

  // Not enough of the owner's own nights to know what "in character" means.
  if (baseline.nights < MIN_BASELINE_NIGHTS) {
    return {
      someoneElse: false,
      deviations,
      reason: `Only ${baseline.nights} night${baseline.nights === 1 ? "" : "s"} of your own on record — too few to tell whose night this is.`,
    };
  }

  // Breathing rate is the anchor: it is the metric that stays put through a
  // late night, a drink or a cold, so an out-of-character value there is the
  // one that genuinely suggests a different body.
  const breathingOut = out("breathing rate");
  const cardiacOut = out("resting heart rate") || out("HRV");

  if (!breathingOut) {
    return {
      someoneElse: false,
      deviations,
      reason: cardiacOut
        ? "Heart rate is unusual for you, but your breathing rate is normal — an unusual night of your own, not a different person."
        : "Vital signs are in character for you.",
    };
  }
  if (!cardiacOut) {
    return {
      someoneElse: false,
      deviations,
      reason:
        "Breathing rate is unusual but the heart data is yours — flagging on one measurement alone is not enough.",
    };
  }

  const worst = [...deviations].sort((a, b) => b.mads - a.mads)[0]!;
  return {
    someoneElse: true,
    deviations,
    reason: `Breathing rate and heart data are both out of character (${worst.metric} ${worst.value.toFixed(1)} against your usual ${worst.median.toFixed(1)}). This night looks like somebody else in the bed.`,
  };
}
