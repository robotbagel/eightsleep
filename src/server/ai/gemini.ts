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

const RecommendationSchema = z.object({
  initialSleepC: z.number(),
  deepSleepC: z.number(),
  midStageSleepC: z.number(),
  finalSleepC: z.number(),
  reasoning: z.string(),
  confidence: z.enum(["low", "medium", "high"]),
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
  sleepGoal: string | null;
  maxDailyShiftC: number;
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
      ? "Experiment history (past profile changes and the sleep scores that followed — use it to keep what worked and revert what did not):\n" +
        historyLines.map((line) => `- ${line}`).join("\n")
      : "",
    "",
    "Recent sleep data (nights from daily trends; recentSessions carry per-third-of-night detail — toss-and-turn counts, average bed temperature in °C, heart rate):",
    JSON.stringify(sleepContext),
    "",
    "Recommend temperatures for tonight. Rules:",
    `- Adjust conservatively: change each stage by at most ${maxDailyShiftC}°C from its current value, and only where the data supports it. Keeping a stage unchanged is a valid choice.`,
    "- Treat this as a running experiment: if the history shows the current configuration is the best performer and recent scores are at or near the best, recommend no change and say the profile looks converged. If recent changes made scores worse, move back toward the best-known configuration.",
    input.displayUnit === "level"
      ? "- In the reasoning, express all bed temperature SETTINGS on the Eight Sleep app slider scale from -10 (coldest) to +10 (warmest), using the exact slider levels given above for the current stages (do not convert degrees yourself; a change of about 1°C is roughly 0.5-1 slider step in the middle of the range). Measured temperatures from sensors (bed/room readings in the data) stay in °C. Cite the specific numbers that drove each change, in plain language, in at most 3 sentences. Set confidence low when data is sparse or mixed, high when the data and history clearly agree. The JSON response fields must still be in °C."
      : "- In the reasoning, talk in °C, cite the specific numbers that drove each change, in plain language, in at most 3 sentences. Set confidence low when data is sparse or mixed, high when the data and history clearly agree.",
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
          },
          required: [
            "initialSleepC",
            "deepSleepC",
            "midStageSleepC",
            "finalSleepC",
            "reasoning",
            "confidence",
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

  return {
    ...parsed,
    initialSleepC: bounded(parsed.initialSleepC, currentProfile.initialSleepC),
    deepSleepC: bounded(parsed.deepSleepC, currentProfile.deepSleepC),
    midStageSleepC: bounded(parsed.midStageSleepC, currentProfile.midStageSleepC),
    finalSleepC: bounded(parsed.finalSleepC, currentProfile.finalSleepC),
  };
}
