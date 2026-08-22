// advisor.ts
// Orchestrates the AI temperature advisor: loads the user's profile, settings
// and recent sleep data, asks Gemini for a recommendation, stores it, and
// (optionally) applies it to the temperature profile the cron executes.
import { db } from "~/server/db";
import {
  aiLiveAdjustments,
  aiRecommendations,
  userAiSettings,
  userTemperatureProfile,
  users,
} from "~/server/db/schema";
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { obtainFreshAccessToken } from "~/server/eight/auth";
import { type Token } from "~/server/eight/types";
import {
  collectSleepContext,
  hasSleepData,
  type SleepContext,
} from "./sleepData";
import {
  AiError,
  GEMINI_MODEL,
  type AiRecommendation,
  generateTemperatureRecommendation,
  isAiConfigured,
} from "./gemini";
import { deriveNightSignals, REGRESSION_SCORE_DROP } from "./rules";
import { minutesSinceTimeOfDay } from "./time";
import { celsiusToRaw, rawToCelsius } from "~/lib/temperature";

// maxDailyShift is stored in tenths of a degree Celsius (20 = 2.0°C).
export const DEFAULT_AI_SETTINGS = {
  aiEnabled: false,
  autoApply: false,
  liveTuningEnabled: false,
  sleepGoal: null as string | null,
  maxDailyShift: 20,
};

type UserRow = typeof users.$inferSelect;

export async function getFreshToken(user: UserRow): Promise<Token> {
  let token: Token = {
    eightAccessToken: user.eightAccessToken,
    eightRefreshToken: user.eightRefreshToken,
    eightExpiresAtPosix: user.eightTokenExpiresAt.getTime(),
    eightUserId: user.eightUserId,
  };

  if (Date.now() > token.eightExpiresAtPosix) {
    token = await obtainFreshAccessToken(
      token.eightRefreshToken,
      token.eightUserId,
    );
    await db
      .update(users)
      .set({
        eightAccessToken: token.eightAccessToken,
        eightRefreshToken: token.eightRefreshToken,
        eightTokenExpiresAt: new Date(token.eightExpiresAtPosix),
      })
      .where(eq(users.email, user.email));
  }

  return token;
}

export async function getAiSettingsOrDefaults(email: string) {
  const settings = await db.query.userAiSettings.findFirst({
    where: eq(userAiSettings.email, email),
  });
  return settings ?? { email, ...DEFAULT_AI_SETTINGS };
}

interface ProfileLevels {
  initial: number;
  mid: number;
  final: number;
}

function formatProfileC(levels: ProfileLevels): string {
  return `${rawToCelsius(levels.initial)}/${rawToCelsius(levels.mid)}/${rawToCelsius(levels.final)}°C`;
}

function sameLevels(a: ProfileLevels, b: ProfileLevels): boolean {
  return a.initial === b.initial && a.mid === b.mid && a.final === b.final;
}

interface ExperimentHistory {
  historyLines: string[];
  bestProfile: ProfileLevels | null;
  bestScore: number | null;
  shouldRevertToBest: boolean;
}

// Reconstructs which profile was active on each scored night by replaying
// applied recommendations, so the loop can learn which configuration produced
// the best sleep and detect regressions.
async function buildExperimentHistory(
  email: string,
  sleepContext: SleepContext,
  currentLevels: ProfileLevels,
): Promise<ExperimentHistory> {
  const appliedRecs = await db
    .select()
    .from(aiRecommendations)
    .where(
      and(
        eq(aiRecommendations.email, email),
        inArray(aiRecommendations.status, ["applied", "auto_applied"]),
      ),
    )
    .orderBy(aiRecommendations.forDate)
    .limit(60);

  const scoredNights = sleepContext.nights
    .filter((night) => night.score != null)
    .sort((a, b) => a.date.localeCompare(b.date));

  const result: ExperimentHistory = {
    historyLines: [],
    bestProfile: null,
    bestScore: null,
    shouldRevertToBest: false,
  };
  if (scoredNights.length === 0) return result;

  const profileForNight = (date: string): ProfileLevels => {
    let active: ProfileLevels | null = null;
    for (const rec of appliedRecs) {
      if (rec.forDate < date) {
        active = {
          initial: rec.recommendedInitialLevel,
          mid: rec.recommendedMidLevel,
          final: rec.recommendedFinalLevel,
        };
      }
    }
    if (active) return active;
    const first = appliedRecs[0];
    if (first) {
      return {
        initial: first.previousInitialLevel,
        mid: first.previousMidLevel,
        final: first.previousFinalLevel,
      };
    }
    return currentLevels;
  };

  const nightsWithProfiles = scoredNights.map((night) => ({
    date: night.date,
    score: night.score!,
    profile: profileForNight(night.date),
  }));

  let best = nightsWithProfiles[0]!;
  for (const night of nightsWithProfiles) {
    if (night.score > best.score) best = night;
  }
  result.bestProfile = best.profile;
  result.bestScore = best.score;

  result.historyLines = nightsWithProfiles
    .slice(-7)
    .reverse()
    .map(
      (night) =>
        `${night.date}: score ${night.score} at ${formatProfileC(night.profile)}${night.date === best.date ? " (best night)" : ""}`,
    );

  const latestTwo = nightsWithProfiles.slice(-2);
  result.shouldRevertToBest =
    latestTwo.length === 2 &&
    latestTwo.every(
      (night) => night.score <= best.score - REGRESSION_SCORE_DROP,
    ) &&
    !sameLevels(currentLevels, best.profile);

  return result;
}

// Summarizes recent live-tuning activity so the nightly advisor can bake
// persistent in-night corrections into the schedule itself.
async function buildLiveTuningSignals(email: string): Promise<string[]> {
  const since = new Date(Date.now() - 36 * 60 * 60 * 1000);
  const adjustments = await db
    .select()
    .from(aiLiveAdjustments)
    .where(
      and(
        eq(aiLiveAdjustments.email, email),
        gte(aiLiveAdjustments.createdAt, since),
      ),
    )
    .orderBy(aiLiveAdjustments.id);

  if (adjustments.length === 0) return [];

  const byStage = new Map<string, { count: number; netTenths: number }>();
  for (const adjustment of adjustments) {
    const entry = byStage.get(adjustment.stage) ?? { count: 0, netTenths: 0 };
    entry.count += 1;
    entry.netTenths += adjustment.offsetDelta;
    byStage.set(adjustment.stage, entry);
  }

  const signals: string[] = [];
  for (const [stage, { count, netTenths }] of byStage) {
    if (netTenths === 0) continue;
    const direction = netTenths < 0 ? "cooler" : "warmer";
    signals.push(
      `Live tuning made ${count} in-night adjustment(s) to the ${stage} stage last night, ending ${Math.abs(netTenths) / 10}°C ${direction} than scheduled — if this keeps happening, bake it into the schedule.`,
    );
  }
  return signals;
}

export async function generateRecommendationForUser(
  email: string,
  source: "cron" | "manual",
): Promise<typeof aiRecommendations.$inferSelect> {
  if (!isAiConfigured()) {
    throw new AiError(
      "GEMINI_API_KEY is not configured. Add it to the Vercel project environment variables.",
    );
  }

  const user = await db.query.users.findFirst({ where: eq(users.email, email) });
  if (!user) {
    throw new AiError("User not found.");
  }

  const profile = await db.query.userTemperatureProfile.findFirst({
    where: eq(userTemperatureProfile.email, email),
  });
  if (!profile) {
    throw new AiError(
      "No temperature profile found. Create a temperature profile first.",
    );
  }

  const settings = await getAiSettingsOrDefaults(email);
  const token = await getFreshToken(user);
  const sleepContext = await collectSleepContext(
    token,
    user.eightUserId,
    profile.timezoneTZ,
  );
  if (!hasSleepData(sleepContext)) {
    throw new AiError(
      "No sleep data is available from Eight Sleep yet. Sleep a night on the pod and try again.",
    );
  }

  const currentLevels: ProfileLevels = {
    initial: profile.initialSleepLevel,
    mid: profile.midStageSleepLevel,
    final: profile.finalSleepLevel,
  };
  const history = await buildExperimentHistory(
    email,
    sleepContext,
    currentLevels,
  );

  let recommendation: AiRecommendation;
  if (history.shouldRevertToBest && history.bestProfile) {
    // Deterministic guardrail: two nights in a row well below the best-known
    // score means the experiment went the wrong way — go straight back.
    recommendation = {
      initialSleepC: rawToCelsius(history.bestProfile.initial),
      midStageSleepC: rawToCelsius(history.bestProfile.mid),
      finalSleepC: rawToCelsius(history.bestProfile.final),
      reasoning: `The last two nights scored at least ${REGRESSION_SCORE_DROP} points below your best night (${history.bestScore}), so this reverts to the best-known configuration (${formatProfileC(history.bestProfile)}) before experimenting further.`,
      confidence: "high",
    };
  } else {
    const signals = [
      ...deriveNightSignals(sleepContext),
      ...(await buildLiveTuningSignals(email)),
    ];
    recommendation = await generateTemperatureRecommendation({
      currentProfile: {
        bedTime: profile.bedTime.slice(0, 5),
        wakeupTime: profile.wakeupTime.slice(0, 5),
        initialSleepC: rawToCelsius(currentLevels.initial),
        midStageSleepC: rawToCelsius(currentLevels.mid),
        finalSleepC: rawToCelsius(currentLevels.final),
      },
      sleepContext,
      signals,
      historyLines: history.historyLines,
      sleepGoal: settings.sleepGoal,
      maxDailyShiftC: settings.maxDailyShift / 10,
    });
  }

  const recommendedLevels: ProfileLevels = {
    initial: celsiusToRaw(recommendation.initialSleepC),
    mid: celsiusToRaw(recommendation.midStageSleepC),
    final: celsiusToRaw(recommendation.finalSleepC),
  };

  const forDate = new Date().toLocaleDateString("en-CA", {
    timeZone: profile.timezoneTZ,
  });
  const autoApplied = source === "cron" && settings.autoApply;

  const inserted = await db
    .insert(aiRecommendations)
    .values({
      email,
      forDate,
      previousInitialLevel: currentLevels.initial,
      previousMidLevel: currentLevels.mid,
      previousFinalLevel: currentLevels.final,
      recommendedInitialLevel: recommendedLevels.initial,
      recommendedMidLevel: recommendedLevels.mid,
      recommendedFinalLevel: recommendedLevels.final,
      reasoning: recommendation.reasoning,
      confidence: recommendation.confidence,
      sleepContextJson: JSON.stringify(sleepContext),
      status: autoApplied ? "auto_applied" : "pending",
      source,
      model: GEMINI_MODEL,
    })
    .returning();

  const row = inserted[0];
  if (!row) {
    throw new AiError("Failed to store the recommendation.");
  }

  if (autoApplied) {
    await db
      .update(userTemperatureProfile)
      .set({
        initialSleepLevel: recommendedLevels.initial,
        midStageSleepLevel: recommendedLevels.mid,
        finalSleepLevel: recommendedLevels.final,
        updatedAt: new Date(),
      })
      .where(eq(userTemperatureProfile.email, email));
    console.log(
      `AI auto-applied temperatures for ${email}: ${formatProfileC(recommendedLevels)}`,
    );
  }

  return row;
}

export async function applyRecommendation(
  email: string,
  recommendationId: number,
): Promise<void> {
  const recommendation = await db.query.aiRecommendations.findFirst({
    where: and(
      eq(aiRecommendations.id, recommendationId),
      eq(aiRecommendations.email, email),
    ),
  });
  if (!recommendation) {
    throw new AiError("Recommendation not found.");
  }
  if (recommendation.status !== "pending") {
    throw new AiError("Only pending recommendations can be applied.");
  }

  await db
    .update(userTemperatureProfile)
    .set({
      initialSleepLevel: recommendation.recommendedInitialLevel,
      midStageSleepLevel: recommendation.recommendedMidLevel,
      finalSleepLevel: recommendation.recommendedFinalLevel,
      updatedAt: new Date(),
    })
    .where(eq(userTemperatureProfile.email, email));

  await db
    .update(aiRecommendations)
    .set({ status: "applied", updatedAt: new Date() })
    .where(eq(aiRecommendations.id, recommendationId));
}

export async function dismissRecommendation(
  email: string,
  recommendationId: number,
): Promise<void> {
  const recommendation = await db.query.aiRecommendations.findFirst({
    where: and(
      eq(aiRecommendations.id, recommendationId),
      eq(aiRecommendations.email, email),
    ),
  });
  if (!recommendation) {
    throw new AiError("Recommendation not found.");
  }

  await db
    .update(aiRecommendations)
    .set({ status: "dismissed", updatedAt: new Date() })
    .where(eq(aiRecommendations.id, recommendationId));
}

// Runs from the 30-minute temperature cron. For every user with AI enabled,
// generates (and optionally auto-applies) one recommendation per day in the
// window 30 minutes to 4 hours after their wake-up time.
export async function runDailyAiPass(): Promise<void> {
  if (!isAiConfigured()) {
    return;
  }

  const rows = await db
    .select()
    .from(userAiSettings)
    .innerJoin(
      userTemperatureProfile,
      eq(userAiSettings.email, userTemperatureProfile.email),
    )
    .where(eq(userAiSettings.aiEnabled, true));

  const now = new Date();
  for (const row of rows) {
    const email = row.userAiSettings.email;
    try {
      const profile = row.userTemperatureProfiles;
      const sinceWakeup = minutesSinceTimeOfDay(
        now,
        profile.timezoneTZ,
        profile.wakeupTime.slice(0, 5),
      );
      if (isNaN(sinceWakeup) || sinceWakeup < 30 || sinceWakeup > 240) {
        continue;
      }

      const forDate = now.toLocaleDateString("en-CA", {
        timeZone: profile.timezoneTZ,
      });
      const existing = await db.query.aiRecommendations.findFirst({
        where: and(
          eq(aiRecommendations.email, email),
          eq(aiRecommendations.forDate, forDate),
          eq(aiRecommendations.source, "cron"),
        ),
      });
      if (existing) {
        continue;
      }

      const recommendation = await generateRecommendationForUser(email, "cron");
      console.log(
        `AI daily pass generated recommendation ${recommendation.id} for ${email} (status: ${recommendation.status})`,
      );
    } catch (error) {
      console.error(
        `AI daily pass failed for ${email}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}
