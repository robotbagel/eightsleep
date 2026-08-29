// verdict.ts
// A plain-language answer to "how did I sleep?", written from the numbers.
//
// The dashboard used to answer that question with a score, four sparklines and
// a hypnogram, and leave the reader to decode it. One sentence at the top does
// more work than all of it: the charts are for when you want to know WHY, not
// for finding out whether the night was good.
//
// Deterministic on purpose — this is the first thing read every morning and it
// must not cost an API call, vary between refreshes, or be wrong in a way
// nobody can trace.

export interface VerdictInput {
  asleepHours: number | null;
  deepHours: number | null;
  remHours: number | null;
  tosses: number | null;
  wakeCount: number | null;
  /** Averages over the recent window, for "compared with usual". */
  average: {
    asleepHours: number | null;
    deepHours: number | null;
    tosses: number | null;
  };
  thermalScore: number | null;
}

export interface Verdict {
  headline: string;
  detail: string;
  tone: "good" | "warn" | "bad" | "none";
}

function minutes(hours: number): number {
  return Math.round(hours * 60);
}

function relative(
  value: number | null,
  reference: number | null,
  unit: "duration" | "count",
): string | null {
  if (value == null || reference == null) return null;
  const diff = value - reference;
  if (unit === "duration") {
    const delta = Math.abs(minutes(diff));
    if (delta < 20) return "about as long as usual";
    const shape = delta >= 60 ? `${Math.round(delta / 60)}h ${delta % 60}m` : `${delta}m`;
    return diff > 0 ? `${shape} longer than usual` : `${shape} less than usual`;
  }
  const delta = Math.abs(Math.round(diff));
  if (delta < 3) return null;
  return diff > 0 ? `${delta} more than usual` : `${delta} fewer than usual`;
}

export function buildVerdict(input: VerdictInput): Verdict {
  if (input.asleepHours == null) {
    return {
      headline: "No night recorded",
      detail: "The pod did not capture a sleep session for this date.",
      tone: "none",
    };
  }

  const quality = input.thermalScore;
  const tone: Verdict["tone"] =
    quality == null
      ? "none"
      : quality >= 80
        ? "good"
        : quality >= 65
          ? "warn"
          : "bad";

  // The headline names the thing that stands out most, so two nights with the
  // same score do not get the same sentence.
  const deepShare =
    input.deepHours != null && input.asleepHours > 0
      ? input.deepHours / input.asleepHours
      : null;
  const restlessness =
    input.tosses != null && input.asleepHours > 0
      ? input.tosses / input.asleepHours
      : null;

  let headline: string;
  // A headline that names a problem must never be painted as a good night:
  // "Light on deep sleep" in green is two contradictory signals at once.
  let negative = false;
  if (quality == null) {
    headline = "Night recorded";
  } else if (deepShare != null && deepShare >= 0.22 && tone !== "bad") {
    headline = "Deep sleep was strong";
  } else if (restlessness != null && restlessness >= 4.5) {
    headline = "A restless night";
    negative = true;
  } else if (input.wakeCount != null && input.wakeCount >= 10) {
    headline = "Broken up by wake-ups";
    negative = true;
  } else if (deepShare != null && deepShare < 0.13) {
    headline = "Light on deep sleep";
    negative = true;
  } else if (tone === "good") {
    headline = "A good night";
  } else if (tone === "warn") {
    headline = "An average night";
  } else {
    headline = "A poor night";
  }
  const shown: Verdict["tone"] =
    negative && tone === "good" ? "warn" : tone;

  const parts: string[] = [];
  const duration = relative(
    input.asleepHours,
    input.average.asleepHours,
    "duration",
  );
  parts.push(
    `You slept ${Math.floor(input.asleepHours)}h ${String(minutes(input.asleepHours) % 60).padStart(2, "0")}m${duration ? `, ${duration}` : ""}`,
  );

  if (input.deepHours != null) {
    const deepDelta = relative(
      input.deepHours,
      input.average.deepHours,
      "duration",
    );
    parts.push(
      `${minutes(input.deepHours)} minutes of deep sleep${deepDelta && deepDelta !== "about as long as usual" ? ` (${deepDelta})` : ""}`,
    );
  }

  const tossDelta = relative(input.tosses, input.average.tosses, "count");
  if (input.tosses != null) {
    parts.push(`${input.tosses} tosses${tossDelta ? ` (${tossDelta})` : ""}`);
  }

  return {
    headline,
    detail: parts.join(", ") + ".",
    tone: shown,
  };
}
