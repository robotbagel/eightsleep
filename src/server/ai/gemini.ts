// gemini.ts
// Calls the Gemini API (structured JSON output) to turn recent sleep metrics,
// research-backed signals, and past-night outcomes into a recommended
// three-stage bed temperature profile. All temperatures are in °C; conversion
// to Eight Sleep raw levels happens in the advisor.
import { z } from "zod";
import { type SleepContext } from "./sleepData";
import {
  celsiusToRaw,
  formatLevelScale,
  MAX_BED_TEMP_C,
  MIN_BED_TEMP_C,
  rawToLevel,
} from "~/lib/temperature";

export const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-3.7-flash";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

export class AiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiError";
  }
}

export function isAiConfigured(): boolean {
  return !!process.env.GEMINI_API_KEY;
}

const GeminiResponseSchema = z.object({
  candidates: z
    .array(
      z.object({
        content: z
          .object({
            parts: z
              .array(z.object({ text: z.string().nullish() }).catchall(z.unknown()))
              .nullish(),
          })
          .nullish(),
      }),
    )
    .nullish(),
});

export const STAGE_KEYS = ["initial", "deep", "mid", "final"] as const;
type StageKey = (typeof STAGE_KEYS)[number];

/** Nights a change is held before it may be revisited (see advisor.ts). */
export const MIN_HOLD_NIGHTS = 2;

// The structured "why". Kept separate from `reasoning` (the one-paragraph
// summary) so the app can show the evidence, the per-stage logic, the
// prediction and the underlying principle as their own things — the point
// being that the sleeper can learn the rule, not just read a verdict.
const ForecastSchema = z.object({
  // A range, never a point: the model must not imply precision it lacks.
  expectedScoreLow: z.number(),
  expectedScoreHigh: z.number(),
  expectedDeepHours: z.number().nullish(),
  expectedTosses: z.number().nullish(),
});

export type RecommendationForecast = z.infer<typeof ForecastSchema>;

const RationaleSchema = z.object({
  perStage: z
    .array(
      z.object({
        stage: z.enum(STAGE_KEYS),
        direction: z.enum(["cooler", "warmer", "unchanged"]),
        why: z.string(),
      }),
    )
    .default([]),
  evidence: z.array(z.string()).default([]),
  expectation: z.string().default(""),
  principle: z.string().default(""),
  forecast: ForecastSchema.nullish(),
});

export type RecommendationRationale = z.infer<typeof RationaleSchema>;

const RecommendationSchema = z.object({
  initialSleepC: z.number(),
  deepSleepC: z.number(),
  midStageSleepC: z.number(),
  finalSleepC: z.number(),
  reasoning: z.string(),
  confidence: z.enum(["low", "medium", "high"]),
  perStage: RationaleSchema.shape.perStage,
  evidence: RationaleSchema.shape.evidence,
  expectation: RationaleSchema.shape.expectation,
  principle: RationaleSchema.shape.principle,
  forecast: ForecastSchema.nullish(),
});

export type AiRecommendation = z.infer<typeof RecommendationSchema>;

export interface AdvisorInput {
  currentProfile: {
    bedTime: string;
    wakeupTime: string;
    initialSleepC: number;
    deepSleepC: number;
    midStageSleepC: number;
    finalSleepC: number;
  };
  sleepContext: SleepContext;
  signals: string[];
  historyLines: string[];
  /** Every profile tried, its measured nights and its mean thermal score. */
  ledgerLines: string[];
  sleepGoal: string | null;
  maxDailyShiftC: number;
  /** Stages changed too recently to have produced evidence; held steady. */
  lockedStages: string[];
  /** How many nights the current profile has been held and measured. */
  nightsOnCurrentProfile: number;
  // How the sleeper reads temperatures in the app: "celsius" (bed water °C)
  // or "level" (the Eight Sleep slider scale, -10 coldest .. +10 warmest,
  // one slider step per °C-ish). Controls only the reasoning wording — the
  // JSON response always carries °C.
  displayUnit: "celsius" | "level";
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

// For slider-scale users, hand the model the exact level equivalent so its
// reasoning quotes the same numbers the app displays (the °C→level mapping is
// nonlinear; the model must not approximate it).
function withLevel(celsius: number, unit: "celsius" | "level"): string {
  if (unit !== "level") return `${celsius}°C`;
  return `${celsius}°C (slider level ${formatLevelScale(rawToLevel(celsiusToRaw(celsius)))})`;
}

function clampC(value: number, min: number, max: number): number {
  return Math.min(Math.max(round1(value), min), max);
}

function buildPrompt(input: AdvisorInput): string {
  const {
    currentProfile,
    sleepContext,
    signals,
    historyLines,
    sleepGoal,
    maxDailyShiftC,
  } = input;
  return [
    `You are a sleep-temperature coach for an Eight Sleep Pod. Each night has four stages, each with a bed water temperature between ${MIN_BED_TEMP_C}°C and ${MAX_BED_TEMP_C}°C, shaping the physiological curve: comfortable onset, a cool trough for slow-wave sleep, easing back toward neutral, then gentle warmth for REM and waking.`,
    "",
    "Current schedule and temperatures:",
    `- Bedtime ${currentProfile.bedTime}, wake-up ${currentProfile.wakeupTime}`,
    `- Initial stage (bedtime to +1h, sleep onset): ${withLevel(currentProfile.initialSleepC, input.displayUnit)}`,
    `- Deep stage (+1h to +3h after bedtime, slow-wave-sleep window — usually the coolest stage): ${withLevel(currentProfile.deepSleepC, input.displayUnit)}`,
    `- Mid stage (+3h until 2h before wake-up): ${withLevel(currentProfile.midStageSleepC, input.displayUnit)}`,
    `- Final stage (last 2h before wake-up, REM-dominant): ${withLevel(currentProfile.finalSleepC, input.displayUnit)}`,
    "",
    sleepGoal ? `The sleeper's own goal/preference: ${sleepGoal}` : "",
    "",
    "Research-backed principles to apply:",
    "- Sleep onset needs a core temperature drop, but mild bed warmth at bedtime (distal skin warming) shortens time to fall asleep.",
    "- Sleep depth has a temperature sweet spot, not 'cooler is better': heat above the comfort band suppresses deep sleep and REM, yet mild within-comfort warming (+0.4°C skin) has been shown to enhance slow-wave sleep and prevent early-morning waking (Raymann 2008). Direction must follow this sleeper's own data.",
    "- Slightly warmer temperatures in the late night promote REM and ease waking.",
    "- Toss-and-turn clusters and elevated heart rate with a warm bed mean too hot; restlessness with a cool bed means too cold.",
    "",
    signals.length > 0
      ? "Signals derived from last night's data:\n" +
        signals.map((signal) => `- ${signal}`).join("\n")
      : "",
    "",
    historyLines.length > 0
      ? "Night by night (thermal score is the only one you are optimising — it is built from deep-sleep share, REM share, restlessness and time awake in bed. The overall score is shown for context only and is mostly sleep DURATION and bedtime consistency, neither of which the bed controls):\n" +
        historyLines.map((line) => `- ${line}`).join("\n")
      : "",
    "",
    input.ledgerLines.length > 0
      ? "What has been tried, grouped by profile (this is the accumulated result, and it outranks any single night):\n" +
        input.ledgerLines.map((line) => `- ${line}`).join("\n")
      : "",
    "",
    "Recent sleep data (nights from daily trends; recentSessions carry per-third-of-night detail — toss-and-turn counts, average bed temperature in °C, heart rate):",
    JSON.stringify(sleepContext),
    "",
    input.lockedStages.length > 0
      ? `Stages currently under measurement and NOT available to change tonight: ${input.lockedStages.join(", ")}. They were adjusted within the last ${MIN_HOLD_NIGHTS} nights and the result is not in yet. Leave them exactly where they are and say so; any value you give for them will be overridden.`
      : "",
    `The current profile has been held for ${input.nightsOnCurrentProfile >= 90 ? "an unknown number of" : input.nightsOnCurrentProfile} nights.`,
    "",
    "Recommend temperatures for tonight. Rules:",
    "- Change AT MOST ONE stage. Only the single largest change you propose is kept; the rest are discarded, so spend it on the stage the evidence is clearest about. Recommending no change at all is a perfectly good answer and is the right one when nothing stands out.",
    "- The pod's setting scale is coarser than 0.1°C: whatever you return is snapped to the nearest temperature the hardware can actually hold. Choose values on a 0.5°C grid, and quote temperatures in the reasoning to that same 0.5°C so the text never names a temperature the bed was not set to.",
    `- Adjust conservatively: change each stage by at most ${maxDailyShiftC}°C from its current value, and only where the data supports it. Keeping a stage unchanged is a valid choice.`,
    "- Treat this as a running experiment: if the history shows the current configuration is the best performer and recent scores are at or near the best, recommend no change and say the profile looks converged. If recent changes made scores worse, move back toward the best-known configuration.",
    input.displayUnit === "level"
      ? "- In the reasoning, express all bed temperature SETTINGS on the Eight Sleep app slider scale from -10 (coldest) to +10 (warmest), using the exact slider levels given above for the current stages (do not convert degrees yourself; a change of about 1°C is roughly 0.5-1 slider step in the middle of the range). Measured temperatures from sensors (bed/room readings in the data) stay in °C. Cite the specific numbers that drove each change, in plain language, in at most 3 sentences. Set confidence low when data is sparse or mixed, high when the data and history clearly agree. The JSON response fields must still be in °C."
      : "- In the reasoning, talk in °C, cite the specific numbers that drove each change, in plain language, in at most 3 sentences. Set confidence low when data is sparse or mixed, high when the data and history clearly agree.",
    "",
    "The sleeper wants to LEARN from this, not just be told. Alongside the recommendation, return:",
    "- perStage: one entry for EACH of the four stages (initial, deep, mid, final), its direction (cooler / warmer / unchanged) and one sentence of `why` naming the specific measurement that drove it. Say plainly when a stage is unchanged and why leaving it alone is the right call.",
    "- evidence: 2 to 5 short factual lines, each a number straight from the data (\"11 tosses in the first third, 4 more than the 7-night average\", \"deep sleep 1h12m against a 1h35m average\"). No advice in these — evidence only.",
    "- expectation: one sentence stating what should measurably improve tomorrow morning if this change is right, so the prediction can be checked (\"fewer than 6 tosses before 01:00 and 15+ minutes more deep sleep\").",
    "- principle: one sentence of the general sleep-physiology rule at work here, phrased so it is worth remembering on its own.",
    "- forecast: what tonight should actually come out at, so the prediction can be checked against tomorrow's measurements. Give expectedScoreLow and expectedScoreHigh as a realistic RANGE for the sleep score shown in the data above (typically 6-12 points wide; widen it when confidence is low), plus expectedDeepHours and expectedTosses. Base the range on this sleeper's own recent nights, not on an ideal — if the change is small, the range should sit close to last night's number.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

export async function generateTemperatureRecommendation(
  input: AdvisorInput,
): Promise<AiRecommendation> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new AiError(
      "GEMINI_API_KEY is not configured. Add it to the Vercel project environment variables.",
    );
  }

  const response = await fetch(GEMINI_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: buildPrompt(input) }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            initialSleepC: { type: "NUMBER" },
            deepSleepC: { type: "NUMBER" },
            midStageSleepC: { type: "NUMBER" },
            finalSleepC: { type: "NUMBER" },
            reasoning: { type: "STRING" },
            confidence: {
              type: "STRING",
              enum: ["low", "medium", "high"],
            },
            perStage: {
              type: "ARRAY",
              items: {
                type: "OBJECT",
                properties: {
                  stage: {
                    type: "STRING",
                    enum: ["initial", "deep", "mid", "final"],
                  },
                  direction: {
                    type: "STRING",
                    enum: ["cooler", "warmer", "unchanged"],
                  },
                  why: { type: "STRING" },
                },
                required: ["stage", "direction", "why"],
              },
            },
            evidence: { type: "ARRAY", items: { type: "STRING" } },
            expectation: { type: "STRING" },
            principle: { type: "STRING" },
            forecast: {
              type: "OBJECT",
              properties: {
                expectedScoreLow: { type: "NUMBER" },
                expectedScoreHigh: { type: "NUMBER" },
                expectedDeepHours: { type: "NUMBER" },
                expectedTosses: { type: "NUMBER" },
              },
              required: ["expectedScoreLow", "expectedScoreHigh"],
            },
          },
          required: [
            "initialSleepC",
            "deepSleepC",
            "midStageSleepC",
            "finalSleepC",
            "reasoning",
            "confidence",
            "perStage",
            "evidence",
            "expectation",
            "principle",
            "forecast",
          ],
        },
        thinkingConfig: { thinkingLevel: "LOW" },
        temperature: 0.3,
      },
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new AiError(
      `Gemini API request failed (${response.status}): ${body.slice(0, 300)}`,
    );
  }

  const data = GeminiResponseSchema.parse(await response.json());
  const text = data.candidates?.[0]?.content?.parts?.find(
    (part) => typeof part.text === "string" && part.text.length > 0,
  )?.text;
  if (!text) {
    throw new AiError("Gemini API returned no content.");
  }

  let parsed: AiRecommendation;
  try {
    parsed = RecommendationSchema.parse(JSON.parse(text));
  } catch (error) {
    throw new AiError(
      `Gemini API returned malformed JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Enforce the shift limit and the temperature bounds regardless of what the
  // model returned — the model is advisory, the clamp is authoritative.
  const { currentProfile, maxDailyShiftC } = input;
  const bounded = (recommended: number, current: number) =>
    clampC(
      clampC(recommended, current - maxDailyShiftC, current + maxDailyShiftC),
      MIN_BED_TEMP_C,
      MAX_BED_TEMP_C,
    );

  const proposed: Record<StageKey, number> = {
    initial: bounded(parsed.initialSleepC, currentProfile.initialSleepC),
    deep: bounded(parsed.deepSleepC, currentProfile.deepSleepC),
    mid: bounded(parsed.midStageSleepC, currentProfile.midStageSleepC),
    final: bounded(parsed.finalSleepC, currentProfile.finalSleepC),
  };
  const current: Record<StageKey, number> = {
    initial: currentProfile.initialSleepC,
    deep: currentProfile.deepSleepC,
    mid: currentProfile.midStageSleepC,
    final: currentProfile.finalSleepC,
  };

  // A stage under measurement is pinned. The model is told, but the pin is
  // enforced here so a forgetful answer cannot break the experiment.
  for (const stage of input.lockedStages) {
    if (stage in proposed) proposed[stage as StageKey] = current[stage as StageKey];
  }

  // One change per night. Two stages moving together cannot be told apart
  // afterwards, and moving all four every night is how a profile ends up back
  // where it started having thrashed ±2°C in between.
  let biggest: StageKey | null = null;
  let biggestDelta = 0;
  for (const stage of STAGE_KEYS) {
    const delta = Math.abs(proposed[stage] - current[stage]);
    if (delta > biggestDelta) {
      biggestDelta = delta;
      biggest = stage;
    }
  }
  for (const stage of STAGE_KEYS) {
    if (stage !== biggest) proposed[stage] = current[stage];
  }

  return {
    ...parsed,
    initialSleepC: proposed.initial,
    deepSleepC: proposed.deep,
    midStageSleepC: proposed.mid,
    finalSleepC: proposed.final,
  };
}
