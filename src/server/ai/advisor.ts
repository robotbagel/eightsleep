// advisor.ts
// Orchestrates the AI temperature advisor: loads the user's profile, settings
// and recent sleep data, asks Gemini for a recommendation, stores it, and
// (optionally) applies it to the temperature profile the cron executes.
import { db } from "~/server/db";
import {
  aiLiveAdjustments,
  aiRecommendations,
  aiRunLog,
  appConfig,
  userAiSettings,
  userTemperatureProfile,
  users,
} from "~/server/db/schema";
import { and, desc, eq, gte, inArray, ne } from "drizzle-orm";
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
import { sendPushToUser } from "~/server/push";
import {
  celsiusToRaw,
  formatRawByUnit,
  rawToCelsius,
  type DisplayUnit,
} from "~/lib/temperature";

// maxDailyShift is stored in tenths of a degree Celsius (20 = 2.0°C).
export const DEFAULT_AI_SETTINGS = {
  aiEnabled: false,
  autoApply: false,
  liveTuningEnabled: false,
  displayUnit: "celsius",
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
  deep: number;
  mid: number;
  final: number;
}

function formatProfileC(levels: ProfileLevels): string {
  return `${rawToCelsius(levels.initial)}/${rawToCelsius(levels.deep)}/${rawToCelsius(levels.mid)}/${rawToCelsius(levels.final)}°C`;
}

function sameLevels(a: ProfileLevels, b: ProfileLevels): boolean {
  return (
    a.initial === b.initial &&
    a.deep === b.deep &&
    a.mid === b.mid &&
    a.final === b.final
  );
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
          deep: rec.recommendedDeepLevel ?? rec.recommendedMidLevel,
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
        deep: first.previousDeepLevel ?? first.previousMidLevel,
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
    email,
  );
  if (!hasSleepData(sleepContext)) {
    throw new AiError(
      "No sleep data is available from Eight Sleep yet. Sleep a night on the pod and try again.",
    );
  }

  const currentLevels: ProfileLevels = {
    initial: profile.initialSleepLevel,
    deep: profile.deepSleepLevel ?? profile.midStageSleepLevel,
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
    const unit: DisplayUnit =
      settings.displayUnit === "level" ? "level" : "celsius";
    const best = history.bestProfile;
    const bestFormatted = `${formatRawByUnit(best.initial, unit)}/${formatRawByUnit(best.deep, unit)}/${formatRawByUnit(best.mid, unit)}/${formatRawByUnit(best.final, unit)}`;
    recommendation = {
      initialSleepC: rawToCelsius(best.initial),
      deepSleepC: rawToCelsius(best.deep),
      midStageSleepC: rawToCelsius(best.mid),
      finalSleepC: rawToCelsius(best.final),
      reasoning: `The last two nights scored at least ${REGRESSION_SCORE_DROP} points below your best night (${history.bestScore}), so this reverts to the best-known configuration (${bestFormatted}) before experimenting further.`,
      confidence: "high",
      // This branch is the deterministic guardrail, not the model, so the
      // rationale is written here rather than generated.
      perStage: (
        [
          ["initial", best.initial],
          ["deep", best.deep],
          ["mid", best.mid],
          ["final", best.final],
        ] as const
      ).map(([stage, level]) => ({
        stage,
        direction:
          level === currentLevels[stage]
            ? ("unchanged" as const)
            : level < currentLevels[stage]
              ? ("cooler" as const)
              : ("warmer" as const),
        why: `Back to ${formatRawByUnit(level, unit)}, the value this stage held on your best-scoring night.`,
      })),
      evidence: [
        `Best night on record scored ${history.bestScore}.`,
        `The last two nights fell at least ${REGRESSION_SCORE_DROP} points short of it.`,
      ],
      expectation: `Scores should return toward ${history.bestScore} within a night or two now that the profile is back at ${bestFormatted}.`,
      principle:
        "When an experiment makes things worse two nights running, return to the best-known setting before trying anything new — otherwise you cannot tell which change caused what.",
    };
  } else {
    const signals = [
      ...deriveNightSignals(sleepContext),
      ...(await buildLiveTuningSignals(email)),
    ];
    const watchOnly =
      sleepContext.recentSessions.length > 0 &&
      sleepContext.recentSessions.every(
        (session) => session.tossesAndTurns.firstThird == null,
      );
    if (watchOnly) {
      signals.push(
        "Sleep data comes from an Apple Watch import: toss-and-turn counts and bed-temperature curves are unavailable, so reason from sleep stages, heart rate, HRV and the score history instead.",
      );
    }
    recommendation = await generateTemperatureRecommendation({
      currentProfile: {
        bedTime: profile.bedTime.slice(0, 5),
        wakeupTime: profile.wakeupTime.slice(0, 5),
        initialSleepC: rawToCelsius(currentLevels.initial),
        deepSleepC: rawToCelsius(currentLevels.deep),
        midStageSleepC: rawToCelsius(currentLevels.mid),
        finalSleepC: rawToCelsius(currentLevels.final),
      },
      sleepContext,
      signals,
      historyLines: history.historyLines,
      sleepGoal: settings.sleepGoal,
      maxDailyShiftC: settings.maxDailyShift / 10,
      displayUnit: settings.displayUnit === "level" ? "level" : "celsius",
    });
  }

  const recommendedLevels: ProfileLevels = {
    initial: celsiusToRaw(recommendation.initialSleepC),
    deep: celsiusToRaw(recommendation.deepSleepC),
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
      previousDeepLevel: currentLevels.deep,
      previousMidLevel: currentLevels.mid,
      previousFinalLevel: currentLevels.final,
      recommendedInitialLevel: recommendedLevels.initial,
      recommendedDeepLevel: recommendedLevels.deep,
      recommendedMidLevel: recommendedLevels.mid,
      recommendedFinalLevel: recommendedLevels.final,
      reasoning: recommendation.reasoning,
      confidence: recommendation.confidence,
      rationaleJson: JSON.stringify({
        perStage: recommendation.perStage ?? [],
        evidence: recommendation.evidence ?? [],
        expectation: recommendation.expectation ?? "",
        principle: recommendation.principle ?? "",
      }),
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
        deepSleepLevel: recommendedLevels.deep,
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
      deepSleepLevel:
        recommendation.recommendedDeepLevel ?? recommendation.recommendedMidLevel,
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

// Builds and sends the push-notification morning report for a freshly
// generated recommendation: last night's stats, what the AI changed and why,
// and what live tuning did overnight.
async function sendMorningReport(
  email: string,
  rec: typeof aiRecommendations.$inferSelect,
  displayUnit: DisplayUnit,
): Promise<void> {
  const fmt = (raw: number) => formatRawByUnit(raw, displayUnit);

  let statsLine = "";
  try {
    const context = rec.sleepContextJson
      ? (JSON.parse(rec.sleepContextJson) as SleepContext)
      : null;
    const session = context?.recentSessions?.[0];
    const nights = context?.nights ?? [];
    const lastNight = nights[nights.length - 1];
    const parts: string[] = [];
    if (lastNight?.score != null) parts.push(`Score ${lastNight.score}`);
    if (lastNight?.sleepDurationHours != null)
      parts.push(`${lastNight.sleepDurationHours}h sleep`);
    if (session?.stageHours?.deep != null)
      parts.push(`deep ${session.stageHours.deep}h`);
    if (session) {
      const tosses =
        (session.tossesAndTurns.firstThird ?? 0) +
        (session.tossesAndTurns.middleThird ?? 0) +
        (session.tossesAndTurns.finalThird ?? 0);
      parts.push(`${tosses} tosses`);
    }
    if (lastNight?.restingHeartRate != null)
      parts.push(`HR ${lastNight.restingHeartRate}`);
    statsLine = parts.join(" · ");
  } catch {
    // stats stay empty; the report still carries the AI assessment
  }

  const stagePairs: [string, number | null, number | null][] = [
    ["initial", rec.previousInitialLevel, rec.recommendedInitialLevel],
    ["deep", rec.previousDeepLevel, rec.recommendedDeepLevel],
    ["mid", rec.previousMidLevel, rec.recommendedMidLevel],
    ["final", rec.previousFinalLevel, rec.recommendedFinalLevel],
  ];
  const changes = stagePairs
    .filter(
      ([, previous, recommended]) =>
        previous != null && recommended != null && previous !== recommended,
    )
    .map(
      ([stage, previous, recommended]) =>
        `${stage} ${fmt(previous!)}→${fmt(recommended!)}`,
    );
  const action =
    changes.length === 0
      ? "AI: no change tonight."
      : `AI ${rec.status === "auto_applied" ? "applied" : "suggests"}: ${changes.join(", ")}.`;

  // Live nudges from the completed night (which started the evening before
  // the recommendation date).
  let liveLine = "";
  try {
    const nightStart = new Date(`${rec.forDate}T12:00:00Z`);
    nightStart.setDate(nightStart.getDate() - 1);
    const night = nightStart.toISOString().slice(0, 10);
    const nudges = await db
      .select()
      .from(aiLiveAdjustments)
      .where(
        and(
          eq(aiLiveAdjustments.email, email),
          eq(aiLiveAdjustments.night, night),
        ),
      );
    if (nudges.length > 0) {
      liveLine = ` Live tuning nudged ${nudges.length}x overnight.`;
    }
  } catch {
    // omit the live line
  }

  await sendPushToUser(email, {
    title: statsLine === "" ? "Your morning sleep report" : statsLine,
    body: `${action}${liveLine} Open for the full report.`,
    url: "/",
  });
}

// Called right after a successful Apple Health import: if the AI is enabled
// and today's assessment hasn't happened yet, run it now — the import IS the
// signal that the night is over, regardless of the usual wake-up window.
export async function triggerAssessmentAfterImport(email: string): Promise<void> {
  const settings = await getAiSettingsOrDefaults(email);
  if (!settings.aiEnabled || !isAiConfigured()) return;

  const profile = await db.query.userTemperatureProfile.findFirst({
    where: eq(userTemperatureProfile.email, email),
  });
  if (!profile) return;

  const forDate = new Date().toLocaleDateString("en-CA", {
    timeZone: profile.timezoneTZ,
  });
  const existing = await db.query.aiRecommendations.findFirst({
    where: and(
      eq(aiRecommendations.email, email),
      eq(aiRecommendations.forDate, forDate),
      eq(aiRecommendations.source, "cron"),
      ne(aiRecommendations.status, "dismissed"),
    ),
  });
  if (existing) return;

  const recommendation = await generateRecommendationForUser(email, "cron");
  console.log(
    `Assessment triggered by health import for ${email}: recommendation ${recommendation.id} (${recommendation.status})`,
  );
  try {
    await sendMorningReport(
      email,
      recommendation,
      settings.displayUnit === "level" ? "level" : "celsius",
    );
  } catch (error) {
    console.error(
      `Morning report push failed for ${email}:`,
      error instanceof Error ? error.message : String(error),
    );
  }
}

// Voids today's assessment and regenerates it from current data: rolls the
// temperature profile back to its pre-assessment levels if the bad
// recommendation was applied, marks it dismissed, generates a fresh one, and
// re-sends the morning report. For when an assessment ran on bad input.
export async function reassessToday(
  email: string,
): Promise<typeof aiRecommendations.$inferSelect> {
  const settings = await getAiSettingsOrDefaults(email);
  const profile = await db.query.userTemperatureProfile.findFirst({
    where: eq(userTemperatureProfile.email, email),
  });
  if (!profile) throw new AiError("No temperature profile found.");

  const forDate = new Date().toLocaleDateString("en-CA", {
    timeZone: profile.timezoneTZ,
  });
  const existing = await db.query.aiRecommendations.findFirst({
    where: and(
      eq(aiRecommendations.email, email),
      eq(aiRecommendations.forDate, forDate),
      eq(aiRecommendations.source, "cron"),
      ne(aiRecommendations.status, "dismissed"),
    ),
  });
  if (existing) {
    if (existing.status === "auto_applied" || existing.status === "applied") {
      await db
        .update(userTemperatureProfile)
        .set({
          initialSleepLevel: existing.previousInitialLevel,
          deepSleepLevel: existing.previousDeepLevel,
          midStageSleepLevel: existing.previousMidLevel,
          finalSleepLevel: existing.previousFinalLevel,
          updatedAt: new Date(),
        })
        .where(eq(userTemperatureProfile.email, email));
      console.log(`reassessToday: rolled back applied levels for ${email}`);
    }
    await db
      .update(aiRecommendations)
      .set({ status: "dismissed", updatedAt: new Date() })
      .where(eq(aiRecommendations.id, existing.id));
  }

  const recommendation = await generateRecommendationForUser(email, "cron");
  try {
    await sendMorningReport(
      email,
      recommendation,
      settings.displayUnit === "level" ? "level" : "celsius",
    );
  } catch (error) {
    console.error(
      `Morning report push failed for ${email}:`,
      error instanceof Error ? error.message : String(error),
    );
  }
  return recommendation;
}

/** Records one daily-pass attempt. Never throws — logging must not break the
 *  thing it is logging. */
async function recordRun(
  email: string,
  forDate: string,
  phase: string,
  ok: boolean,
  detail?: string,
): Promise<void> {
  try {
    await db.insert(aiRunLog).values({
      email,
      forDate,
      phase,
      ok,
      detail: detail?.slice(0, 500) ?? null,
    });
  } catch (error) {
    console.error(
      `Failed to record AI run for ${email}:`,
      error instanceof Error ? error.message : String(error),
    );
  }
}

/** Heartbeat so "the cron never fired" is distinguishable from "it fired and
 *  the pass failed". Written on every tick, read by /api/aiStatus. */
export async function recordCronHeartbeat(): Promise<void> {
  try {
    const at = new Date().toISOString();
    await db
      .insert(appConfig)
      .values({ key: "cron:lastRunAt", value: at })
      .onConflictDoUpdate({
        target: appConfig.key,
        set: { value: at },
      });
  } catch (error) {
    console.error(
      "Failed to record cron heartbeat:",
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * Runs from the 30-minute temperature cron. For every user with AI enabled,
 * generates (and optionally auto-applies) one recommendation per day.
 *
 * The window opens 30 minutes after wake-up (the night has to be finished and
 * uploaded) and stays open until an hour before bedtime. It used to close
 * after four hours, which meant a handful of failed ticks in the morning cost
 * the whole day silently — a plan produced at 15:00 still governs tonight, so
 * there is no reason to give up at 11:00.
 */
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
      const sinceBedtime = minutesSinceTimeOfDay(
        now,
        profile.timezoneTZ,
        profile.bedTime.slice(0, 5),
      );
      // Closes an hour before bedtime: after that the plan would land as the
      // pod is already pre-heating for the night it is meant to govern.
      const beforeBedtime = isNaN(sinceBedtime) || sinceBedtime <= -60;
      if (isNaN(sinceWakeup) || sinceWakeup < 30 || !beforeBedtime) {
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
          ne(aiRecommendations.status, "dismissed"),
        ),
      });
      if (existing) {
        continue;
      }

      const recommendation = await generateRecommendationForUser(email, "cron");
      await recordRun(
        email,
        forDate,
        "recommendation",
        true,
        `id ${recommendation.id} (${recommendation.status})`,
      );
      console.log(
        `AI daily pass generated recommendation ${recommendation.id} for ${email} (status: ${recommendation.status})`,
      );
      try {
        const settings = await getAiSettingsOrDefaults(email);
        await sendMorningReport(
          email,
          recommendation,
          settings.displayUnit === "level" ? "level" : "celsius",
        );
      } catch (error) {
        console.error(
          `Morning report push failed for ${email}:`,
          error instanceof Error ? error.message : String(error),
        );
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const forDate = new Date().toLocaleDateString("en-CA", {
        timeZone: row.userTemperatureProfiles.timezoneTZ,
      });
      await recordRun(email, forDate, "recommendation", false, detail);
      console.error(`AI daily pass failed for ${email}:`, detail);
    }
  }
}
