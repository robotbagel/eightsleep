// why.ts
// Explanations written for the person sleeping, not for the controller.
//
// The first version said things like "a correction that repeats every night is
// the base setting being wrong, not a bad night". That is true, and it is a
// note about how the control loop works — it never told the sleeper WHY a
// cooler middle-of-the-night would help them, which is the only part they can
// act on or learn from. Every string here leads with the physiological
// mechanism and names the measurement from their own night that triggered it.
import { type Stage } from "./control";

export const STAGE_NAME: Record<Stage, string> = {
  initial: "falling asleep",
  deep: "deep sleep",
  mid: "middle of the night",
  final: "REM and wake-up",
};

export const STAGE_WINDOW: Record<Stage, string> = {
  initial: "the first hour",
  deep: "roughly one to three hours in",
  mid: "the middle third of the night",
  final: "the last two hours before your alarm",
};

/** What a cooler or warmer bed does at each stage, in one sentence. */
export function mechanism(stage: Stage, direction: "cooler" | "warmer"): string {
  if (direction === "cooler") {
    switch (stage) {
      case "initial":
        return "Falling asleep needs your core temperature to drop, and it can only do that by shedding heat through your skin. A bed that is too warm at bedtime blocks that, so you lie there longer.";
      case "deep":
        return "Slow-wave sleep happens while your core temperature is at its lowest. Heat in the first hours cuts it short, which is why deep sleep is the first thing to disappear on a warm night.";
      case "mid":
        return "By the middle of the night your body is at its natural temperature low. A bed running above that pushes you into brief arousals you mostly do not remember, which is what fragments the night.";
      case "final":
        return "In REM your body largely stops regulating its own temperature, so it takes the bed's. Too warm here and you surface repeatedly in the last stretch, which is the classic 5am waking.";
    }
  }
  switch (stage) {
    case "initial":
      return "Mild warmth at bedtime widens the blood vessels in your hands and feet, which is how your core sheds heat and how you fall asleep faster. Too cold and that never gets going.";
    case "deep":
      return "Deep sleep needs cool, but below your comfort band the cold itself becomes an arousal — you shiver awake instead of sinking.";
    case "mid":
      return "Cold in the middle of the night pulls blood away from your skin and wakes you rather than settling you.";
    case "final":
      return "REM is protected by gentle warmth. A bed that has drifted too cold before your alarm cuts the last REM block short and makes waking harder.";
  }
}

/** The general rule worth remembering, per stage and direction. */
export function principle(stage: Stage, direction: "cooler" | "warmer"): string {
  if (stage === "final") {
    return direction === "cooler"
      ? "Your body stops regulating its own temperature during REM, so the last hours of the night are the most sensitive to a bed that is too warm."
      : "Warmth late in the night protects REM; the same warmth early in the night would have cost you deep sleep.";
  }
  if (stage === "deep" || stage === "mid") {
    return direction === "cooler"
      ? "Your core temperature has to fall for deep sleep to consolidate — warmth in the first half of the night is the single most common reason it does not."
      : "Cooler is not always better: below your comfort band the cold itself becomes an arousal.";
  }
  return direction === "cooler"
    ? "Falling asleep is a heat-loss problem: your core has to drop, and a warm bed at bedtime prevents it."
    : "Warm hands and feet at bedtime are how your core sheds heat — mild warmth helps you fall asleep, it does not fight it.";
}

/**
 * The measurement from THIS sleeper's night that justifies the move, as a
 * sentence. Falls back gracefully when a figure is missing rather than
 * inventing one.
 */
export function observation(input: {
  stage: Stage;
  direction: "cooler" | "warmer";
  tosses: number | null;
  bedTempC: number | null;
  liveNights: number | null;
  reportedNights: number | null;
}): string {
  const where = STAGE_WINDOW[input.stage];
  const bits: string[] = [];

  if (input.reportedNights != null) {
    bits.push(
      `you told the app the bed felt too ${input.direction === "cooler" ? "hot" : "cold"} at that point on ${input.reportedNights} of the last 3 nights`,
    );
  }
  if (input.liveNights != null) {
    bits.push(
      `the pod had to be ${input.direction === "cooler" ? "cooled" : "warmed"} mid-night on ${input.liveNights} of the last 3 nights`,
    );
  }
  if (input.tosses != null && input.tosses > 0) {
    bits.push(`you turned over ${input.tosses} times during ${where}`);
  }
  if (input.bedTempC != null) {
    bits.push(`with the bed measuring around ${input.bedTempC.toFixed(1)}°C`);
  }

  if (bits.length === 0) return `Measured across ${where}.`;
  const sentence = bits.join(", ");
  return sentence.charAt(0).toUpperCase() + sentence.slice(1) + ".";
}
