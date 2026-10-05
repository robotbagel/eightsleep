// insights.ts
// The morning reading, written the way the iOS 27 Health app writes it: a
// verdict, the change against YOUR usual and why it matters, the things that
// helped and held the night back, and at most one thing to do about it.
//
// Every comparison is against the sleeper's own nights, never a population
// norm: "38 minutes of deep sleep" means nothing on its own, "22 minutes less
// than your usual" is something a person can act on. Pure and deterministic,
// like verdict.ts: it is the first thing read every morning and must not vary
// between refreshes or cost a request.

export interface InsightNight {
  night: string;
  asleepHours: number | null;
  deepHours: number | null;
  remHours: number | null;
  tosses: number | null;
  wakeCount: number | null;
  sleepLatencyHours: number | null;
  restingHeartRate: number | null;
  hrv: number | null;
  respiratoryRate: number | null;
  thermalScore: number | null;
  notMe?: boolean | null;
}

export type Rating = "Very low" | "Low" | "OK" | "High" | "Very high";
export type Effect = "helped" | "held-back" | "typical";
export type VitalStatus = "Typical" | "Favorable" | "Slightly off" | "Notably off";

export interface Contributor {
  key: "asleep" | "deep" | "rem" | "restless" | "latency" | "wakeups";
  label: string;
  value: string;
  /** In words, against the usual: "22 min more than usual". */
  comparison: string;
  effect: Effect;
  /** How far from usual, in comparable units; ranks the drivers. */
  weight: number;
}

export interface Vital {
  key: "restingHeartRate" | "hrv" | "respiratoryRate";
  label: string;
  unit: string;
  value: number | null;
  /** The usual range (median +/- 2 MAD), for drawing the band. */
  low: number | null;
  high: number | null;
  median: number | null;
  status: VitalStatus | null;
}

export interface Insight {
  rating: Rating | null;
  headline: string;
  summary: string;
  contributors: Contributor[];
  vitals: Vital[];
  vitalsStatus: VitalStatus | null;
  vitalsSummary: string;
  tip: string | null;
  /** Own nights the comparison rests on. */
  baselineNights: number;
}

/** Fewer own nights than this and "usual" is not yet a thing. */
export const MIN_BASELINE = 5;

/** Apple's Sleep Score bands since watchOS 26.2. */
export function ratingFor(score: number | null): Rating | null {
  if (score == null) return null;
  if (score >= 96) return "Very high";
  if (score >= 81) return "High";
  if (score >= 61) return "OK";
  if (score >= 41) return "Low";
  return "Very low";
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function mad(values: number[], centre: number, floor: number): number {
  return Math.max(median(values.map((v) => Math.abs(v - centre))) ?? 0, floor);
}

function hm(hours: number): string {
  const total = Math.round(hours * 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h === 0 ? `${m} min` : `${h}h ${String(m).padStart(2, "0")}m`;
}

function minutesWord(diffHours: number): string {
  const m = Math.round(Math.abs(diffHours) * 60);
  return m >= 60 ? hm(Math.abs(diffHours)) : `${m} min`;
}

const pick = (
  nights: InsightNight[],
  get: (n: InsightNight) => number | null,
): number[] => nights.map(get).filter((v): v is number => v != null && isFinite(v));

const perHour = (n: InsightNight): number | null =>
  n.tosses != null && n.asleepHours ? n.tosses / n.asleepHours : null;

/**
 * Builds the reading for `night` against the sleeper's other nights. `history`
 * may include the night itself and anybody else's nights; both are dropped.
 */
export function buildInsight(night: InsightNight, history: InsightNight[]): Insight {
  const own = history.filter((n) => n.night !== night.night && n.notMe !== true);
  const enough = own.length >= MIN_BASELINE;
  const usual = (get: (n: InsightNight) => number | null) =>
    enough ? median(pick(own, get)) : null;

  const contributors: Contributor[] = [];
  const add = (c: Contributor | null) => {
    if (c) contributors.push(c);
  };

  // Time asleep: half an hour either way is a night anyone would notice.
  if (night.asleepHours != null) {
    const ref = usual((n) => n.asleepHours);
    const diff = ref == null ? null : night.asleepHours - ref;
    add({
      key: "asleep",
      label: "Time asleep",
      value: hm(night.asleepHours),
      comparison:
        diff == null
          ? "no usual yet"
          : Math.abs(diff) < 20 / 60
            ? "about your usual"
            : `${minutesWord(diff)} ${diff > 0 ? "more" : "less"} than usual`,
      effect:
        diff == null ? "typical" : diff >= 20 / 60 ? "helped" : diff <= -30 / 60 ? "held-back" : "typical",
      weight: diff == null ? 0 : Math.abs(diff) / 0.5,
    });
  }

  // Deep and REM: ten minutes is the smallest change the pod resolves
  // reliably night to night.
  for (const [key, label, get] of [
    ["deep", "Deep sleep", (n: InsightNight) => n.deepHours],
    ["rem", "REM sleep", (n: InsightNight) => n.remHours],
  ] as const) {
    const value = get(night);
    if (value == null) continue;
    const ref = usual(get);
    const diff = ref == null ? null : value - ref;
    add({
      key,
      label,
      value: hm(value),
      comparison:
        diff == null
          ? "no usual yet"
          : Math.abs(diff) < 10 / 60
            ? "about your usual"
            : `${minutesWord(diff)} ${diff > 0 ? "more" : "less"} than usual`,
      effect:
        diff == null ? "typical" : diff >= 10 / 60 ? "helped" : diff <= -10 / 60 ? "held-back" : "typical",
      weight: diff == null ? 0 : Math.abs(diff) / (10 / 60),
    });
  }

  // Restlessness as a RATE, so a long night is not penalised for being long.
  const rate = perHour(night);
  if (rate != null && night.tosses != null) {
    const ref = usual(perHour);
    const ratio = ref == null || ref === 0 ? null : rate / ref;
    const extra =
      ref == null || night.asleepHours == null ? null : night.tosses - ref * night.asleepHours;
    const restless = ratio != null && ratio >= 1.25 && (extra ?? 0) >= 3;
    const calm = ratio != null && ratio <= 0.8 && (extra ?? 0) <= -3;
    add({
      key: "restless",
      label: "Tossing and turning",
      value: `${night.tosses} times`,
      comparison:
        ratio == null
          ? "no usual yet"
          : restless || calm
            ? `${Math.abs(Math.round(extra ?? 0))} ${restless ? "more" : "fewer"} than usual`
            : "about your usual",
      effect: restless ? "held-back" : calm ? "helped" : "typical",
      weight: ratio == null ? 0 : Math.abs(ratio - 1) / 0.25,
    });
  }

  // Falling asleep: under 20 minutes is healthy for anyone, over 30 is slow
  // for anyone, so absolute bounds here, compared with the usual in words.
  if (night.sleepLatencyHours != null) {
    const minutes = Math.round(night.sleepLatencyHours * 60);
    const ref = usual((n) => n.sleepLatencyHours);
    const refMin = ref == null ? null : Math.round(ref * 60);
    add({
      key: "latency",
      label: "Falling asleep",
      value: `${minutes} min`,
      comparison:
        refMin == null
          ? "no usual yet"
          : Math.abs(minutes - refMin) < 10
            ? "about your usual"
            : `${Math.abs(minutes - refMin)} min ${minutes > refMin ? "slower" : "quicker"} than usual`,
      effect: minutes >= 30 ? "held-back" : minutes <= 15 ? "helped" : "typical",
      weight: minutes >= 30 ? (minutes - 20) / 10 : minutes <= 15 ? 1 : 0,
    });
  }

  if (night.wakeCount != null) {
    const ref = usual((n) => n.wakeCount);
    const diff = ref == null ? null : night.wakeCount - ref;
    add({
      key: "wakeups",
      label: "Wake-ups",
      value: `${night.wakeCount}`,
      comparison:
        diff == null
          ? "no usual yet"
          : Math.abs(diff) < 3
            ? "about your usual"
            : `${Math.abs(Math.round(diff))} ${diff > 0 ? "more" : "fewer"} than usual`,
      effect: diff == null ? "typical" : diff >= 3 ? "held-back" : diff <= -3 ? "helped" : "typical",
      weight: diff == null ? 0 : Math.abs(diff) / 3,
    });
  }

  const helped = contributors
    .filter((c) => c.effect === "helped")
    .sort((a, b) => b.weight - a.weight);
  const heldBack = contributors
    .filter((c) => c.effect === "held-back")
    .sort((a, b) => b.weight - a.weight);

  const rating = ratingFor(night.thermalScore);
  const good = night.thermalScore != null && night.thermalScore >= 81;
  const poor = night.thermalScore != null && night.thermalScore <= 60;
  // What the reading leads with follows the score: a High night leads with
  // what went right and mentions a weak spot second, a Low night leads with
  // what went wrong. "A Restless Night" over a ring reading 89 High says two
  // contradictory things at once.
  const lead = poor
    ? (heldBack[0] ?? helped[0])
    : good
      ? (helped[0] ?? heldBack[0])
      : heldBack[0] && (!helped[0] || heldBack[0].weight >= helped[0].weight * 0.8)
        ? heldBack[0]
        : helped[0];
  const caveat = good && lead?.effect === "helped" ? heldBack[0] : undefined;

  const HEADLINE: Record<Contributor["key"], [string, string]> = {
    asleep: ["A Longer Night Than Usual", "A Short Night"],
    deep: ["More Deep Sleep Than Usual", "Light on Deep Sleep"],
    rem: ["More REM Than Usual", "Less REM Than Usual"],
    restless: ["A Calm, Still Night", "A Restless Night"],
    latency: ["You Fell Asleep Quickly", "Slow to Fall Asleep"],
    wakeups: ["Fewer Wake-Ups Than Usual", "Broken Up by Wake-Ups"],
  };
  const WHY: Record<Contributor["key"], [string, string]> = {
    asleep: [
      "More time asleep gives every stage room, and it lifted your score.",
      "Deep sleep and REM are the first things a short night cuts.",
    ],
    deep: [
      "Deep sleep is the physically restoring part of the night, and the part the bed's temperature affects most.",
      "Deep sleep is the physically restoring part of the night, and heat in the first hours is the usual reason it shrinks.",
    ],
    rem: [
      "REM comes mostly in the last hours, so a calm, gently warm morning stretch protects it.",
      "REM comes mostly in the last hours; a bed that is too cool or too warm then cuts it short.",
    ],
    restless: [
      "Lying still means the bed's temperature suited you.",
      "Turning over this often usually means the bed was too warm for part of the night.",
    ],
    latency: [
      "Falling asleep needs your body to shed heat, and it managed that easily.",
      "Falling asleep needs your body to shed heat; a bed that is warm when you get in slows that down.",
    ],
    wakeups: [
      "Fewer interruptions helped lift your score.",
      "Short wake-ups you may not remember still break the night into pieces.",
    ],
  };

  const NOUN: Record<Contributor["key"], string> = {
    asleep: "sleep",
    deep: "deep sleep",
    rem: "REM sleep",
    restless: "",
    latency: "",
    wakeups: "",
  };

  const SHORTFALL: Record<Contributor["key"], string> = {
    asleep: "a shorter night",
    deep: "less deep sleep",
    rem: "less REM",
    restless: "more tossing and turning",
    latency: "taking longer to fall asleep",
    wakeups: "more wake-ups",
  };
  const caveatText = (() => {
    if (!caveat) return "";
    const named = heldBack.slice(0, 2).map((c) => SHORTFALL[c.key]);
    const list = named.length === 2 ? `${named[0]} and ${named[1]}` : named[0];
    return ` What held it back was ${list} than usual.`;
  })();

  let headline: string;
  let summary: string;
  if (night.asleepHours == null) {
    headline = "No Night Recorded";
    summary = "The pod did not capture a sleep session for this date.";
  } else if (!enough) {
    headline = good ? "A Good Night's Sleep" : poor ? "A Rough Night" : "Night Recorded";
    summary = `You slept ${hm(night.asleepHours)}. After ${MIN_BASELINE} nights of your own the app can tell you how this compares with your usual; it has ${own.length} so far.`;
  } else if (!lead) {
    headline = good ? "A Good Night's Sleep" : poor ? "A Rough Night" : "A Typical Night";
    summary = `Everything was close to your usual: ${hm(night.asleepHours)} asleep${night.deepHours != null ? `, ${hm(night.deepHours)} of it deep` : ""}.`;
  } else {
    const isHeld = lead.effect === "held-back";
    headline =
      good && !isHeld && helped.length >= 2
        ? "A Good Night's Sleep"
        : HEADLINE[lead.key][isHeld ? 1 : 0];
    const what =
      lead.key === "restless"
        ? `You turned over ${lead.comparison.replace(" than usual", "")} than usual`
        : lead.key === "latency"
          ? `It took you ${lead.value} to fall asleep, ${lead.comparison}`
          : lead.key === "wakeups"
            ? `You woke ${lead.comparison.replace(" than usual", "")} times than usual`
            : `You got ${lead.comparison.replace(" than usual", "")} ${NOUN[lead.key]} than usual`;
    summary = `${what}. ${WHY[lead.key][isHeld ? 1 : 0]}${caveatText}`;
  }

  // ---- overnight vitals against their own typical range -----------------
  const VITALS = [
    { key: "restingHeartRate", label: "Resting heart rate", unit: "bpm", floor: 1.5, lowerIsBetter: true },
    { key: "hrv", label: "HRV", unit: "ms", floor: 6, lowerIsBetter: false },
    { key: "respiratoryRate", label: "Breathing", unit: "/min", floor: 0.3, lowerIsBetter: null },
  ] as const;
  const vitals: Vital[] = VITALS.map((def) => {
    const value = night[def.key];
    const series = pick(own, (n) => n[def.key]);
    const centre = enough ? median(series) : null;
    if (value == null || centre == null) {
      return { key: def.key, label: def.label, unit: def.unit, value, low: null, high: null, median: centre, status: null };
    }
    const spread = mad(series, centre, def.floor);
    const z = (value - centre) / spread;
    const better =
      def.lowerIsBetter == null ? false : def.lowerIsBetter ? z < 0 : z > 0;
    const status: VitalStatus =
      Math.abs(z) <= 2 ? "Typical" : better ? "Favorable" : Math.abs(z) <= 3.5 ? "Slightly off" : "Notably off";
    return {
      key: def.key,
      label: def.label,
      unit: def.unit,
      value,
      low: centre - 2 * spread,
      high: centre + 2 * spread,
      median: centre,
      status,
    };
  });
  const statuses = vitals.map((v) => v.status).filter((s): s is VitalStatus => s != null);
  const vitalsStatus: VitalStatus | null =
    statuses.length === 0
      ? null
      : statuses.includes("Notably off")
        ? "Notably off"
        : statuses.includes("Slightly off")
          ? "Slightly off"
          : statuses.includes("Favorable")
            ? "Favorable"
            : "Typical";
  const off = vitals.filter((v) => v.status === "Slightly off" || v.status === "Notably off");
  const fmt = (v: Vital, x: number) => (v.key === "respiratoryRate" ? x.toFixed(1) : `${Math.round(x)}`);
  const vitalsSummary =
    vitalsStatus == null
      ? enough
        ? "The pod did not record your vitals this night."
        : "Your typical range needs a few more nights of your own."
      : off.length === 0
        ? vitalsStatus === "Favorable"
          ? "Your heart was more relaxed than usual overnight, a sign of good recovery."
          : "Heart rate, HRV and breathing were all within your usual range."
        : `${off
            .map((v) => `${v.label} was ${v.value! > v.median! ? "higher" : "lower"} than usual (${fmt(v, v.value!)} against ${fmt(v, v.median!)})`)
            .join("; ")}. Late meals, alcohol, illness or a hard day show up here; it is rarely the bed.`;

  // ---- one thing to try -------------------------------------------------
  const TIP: Partial<Record<Contributor["key"], string>> = {
    latency:
      "If the bed feels warm when you get in, press − once on the control at the top. The press tells the autopilot your first stage is too warm, and tomorrow's starts cooler.",
    restless:
      "Next time you wake up warm or cold, press − or + on the control at the top instead of waiting for the morning. A press names the stage that was wrong, which a morning answer cannot.",
    deep:
      "If deep sleep stays low, the first hours are usually too warm. Pressing − during the first part of the night is the quickest way to teach the autopilot that.",
    rem:
      "If you wake early feeling cold, press + then. The REM stage runs in the last hours and that press warms just that part of the night.",
    asleep:
      "The schedule assumes your usual bedtime. On a night you go to bed later, the cool deep-sleep stage starts before you are asleep and is partly wasted.",
  };
  const tip =
    heldBack[0] && TIP[heldBack[0].key]
      ? TIP[heldBack[0].key]!
      : vitalsStatus === "Notably off"
        ? "Your body was under more strain than usual overnight. An early night and a lighter evening tend to bring these back to your usual range."
        : null;

  return {
    rating,
    headline,
    summary,
    contributors,
    vitals,
    vitalsStatus,
    vitalsSummary,
    tip,
    baselineNights: own.length,
  };
}
