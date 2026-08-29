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
  sleepFeedback,
  temperatureEvents,
  userAiSettings,
  userTemperatureProfile,
  users,
} from "~/server/db/schema";
import { and, desc, eq, gte, inArray, ne, sql } from "drizzle-orm";
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
import { deriveNightSignals } from "./rules";
import {
  mechanism,
  observation,
  principle as principleFor,
  STAGE_NAME,
} from "./why";
import {
  buildLedger,
  decide,
  describeLedger,
  livePressure,
  MIN_HOLD_NIGHTS,
  STAGES,
  type LedgerEntry,
  type LivePressure,
  type ScoredNight,
  type Stage,
} from "./control";
import { minutesSinceTimeOfDay } from "./time";
import { readNightMetrics, shiftDate, syncNightMetrics } from "./history";
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

const where = (stage: Stage) =>
  stage === "initial"
    ? "the first hour"
    : stage === "deep"
      ? "the first third of the night"
      : stage === "mid"
        ? "the middle of the night"
        : "the last hours before your alarm";

const STAGE_LABELS: Record<Stage, string> = {
  initial: "falling-asleep",
  deep: "deep-sleep",
  mid: "middle-of-the-night",
  final: "REM and wake-up",
};

/** A forecast band from what this profile has actually averaged, rather than
 *  a number the model invented. Widens when there is little to go on. */
function forecastFromLedger(ledger: LedgerEntry[]) {
  const current = ledger.find((entry) => entry.current);
  const reference = current ?? ledger[0];
  if (!reference) return null;
  const spread = reference.nights.length >= MIN_HOLD_NIGHTS ? 5 : 9;
  return {
    expectedScoreLow: Math.max(0, Math.round(reference.meanThermal - spread)),
    expectedScoreHigh: Math.min(100, Math.round(reference.meanThermal + spread)),
  };
}

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

interface ExperimentHistory {
  historyLines: string[];
  bestProfile: ProfileLevels | null;
  bestScore: number | null;
  /** Nights we can prove the pod actually ran our profile. */
  verifiedNights: number;
  unverifiedNights: number;
  /** Stages changed too recently to have been measured yet. */
  lockedStages: string[];
  /** Nights the current profile has been held and measured. */
  nightsOnCurrentProfile: number;
  /** Every distinct profile tried, with its mean thermal score. */
  ledger: LedgerEntry[];
  /** Stages live tuning keeps correcting the same way. */
  pressure: LivePressure[];
  /** Which way each locked stage was last moved. */
  lockDirection: Partial<Record<Stage, "cooler" | "warmer">>;
  /** The wake date of the first night the held change actually ran on. */
  lastChangeNight: string | null;
}

async function stagesLockedByRecentChanges(
  email: string,
  todayKey: string,
): Promise<{
  locked: string[];
  heldNights: number;
  lockDirection: Partial<Record<Stage, "cooler" | "warmer">>;
  lastChangeNight: string | null;
}> {
  const recent = await db
    .select()
    .from(aiRecommendations)
    .where(
      and(
        eq(aiRecommendations.email, email),
        inArray(aiRecommendations.status, ["applied", "auto_applied"]),
      ),
    )
    .orderBy(desc(aiRecommendations.forDate))
    .limit(MIN_HOLD_NIGHTS + 2);

  const cutoff = new Date(`${todayKey}T12:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - MIN_HOLD_NIGHTS);
  const cutoffKey = cutoff.toISOString().slice(0, 10);

  const locked = new Set<string>();
  const lockDirection: Partial<Record<Stage, "cooler" | "warmer">> = {};
  let heldNights = 99;
  // A change made on D governs the night woken from on D+1, so that is the
  // first night a report could be about.
  let lastChangeNight: string | null = null;
  for (const rec of recent) {
    if (rec.forDate >= todayKey) continue; // today's own row, if any
    const pairs: [Stage, number, number][] = [
      ["initial", rec.previousInitialLevel, rec.recommendedInitialLevel],
      [
        "deep",
        rec.previousDeepLevel ?? rec.previousMidLevel,
        rec.recommendedDeepLevel ?? rec.recommendedMidLevel,
      ],
      ["mid", rec.previousMidLevel, rec.recommendedMidLevel],
      ["final", rec.previousFinalLevel, rec.recommendedFinalLevel],
    ];
    const changed: [string, boolean][] = pairs.map(([stage, from, to]) => [
      stage,
      from !== to,
    ]);
    const anyChange = changed.some(([, did]) => did);
    if (anyChange) {
      const since = Math.round(
        (new Date(`${todayKey}T12:00:00Z`).getTime() -
          new Date(`${rec.forDate}T12:00:00Z`).getTime()) /
          86_400_000,
      );
      heldNights = Math.min(heldNights, since);
      if (rec.forDate > cutoffKey) {
        for (const [stage, from, to] of pairs) {
          if (from === to) continue;
          locked.add(stage);
          // Newest recommendation wins: the loop reads them newest-first.
          lockDirection[stage] ??= to < from ? "cooler" : "warmer";
        }
        const governed = new Date(`${rec.forDate}T12:00:00Z`);
        governed.setUTCDate(governed.getUTCDate() + 1);
        const key = governed.toISOString().slice(0, 10);
        if (lastChangeNight == null || key > lastChangeNight) {
          lastChangeNight = key;
        }
      }
    }
  }
  return {
    locked: [...locked],
    heldNights: heldNights === 99 ? 99 : heldNights,
    lockDirection,
    lastChangeNight,
  };
}

/**
 * Which nights we can PROVE the pod ran our schedule, from the temperature
 * changes the cron logged. Nights the scheduler was down still produce a
 * perfectly good sleep score — the pod records the night either way — so
 * without this check the experiment loop happily credits a profile that was
 * never in effect. (Audited 2026-08-25: the scheduler was down for at least
 * the night of 08-23, whose score the loop was treating as evidence.)
 *
 * `temperatureEvents.night` is keyed by the date the night STARTED, while
 * sleep nights are keyed by the wake date, so the night woken from on D was
 * driven by events stored under D-1.
 */
async function drivenNights(email: string): Promise<Set<string>> {
  const driven = new Set<string>();
  try {
    const rows = await db
      .select({ night: temperatureEvents.night, source: temperatureEvents.source })
      .from(temperatureEvents)
      .where(eq(temperatureEvents.email, email));
    const counts = new Map<string, number>();
    for (const row of rows) {
      if (row.source === "off") continue; // a wake-up off is not a night's schedule
      counts.set(row.night, (counts.get(row.night) ?? 0) + 1);
    }
    for (const [night, count] of counts) {
      // A driven night sends several stage changes; one stray event is not a
      // night under our control.
      if (count >= 2) {
        const wake = new Date(`${night}T12:00:00Z`);
        wake.setUTCDate(wake.getUTCDate() + 1);
        driven.add(wake.toISOString().slice(0, 10));
      }
    }
  } catch (error) {
    console.error(
      `Could not read driven nights for ${email}:`,
      error instanceof Error ? error.message : String(error),
    );
  }
  return driven;
}

// Reconstructs which profile was active on each scored night by replaying
// applied recommendations, so the loop can learn which configuration produced
// the best sleep and detect regressions.
async function buildExperimentHistory(
  email: string,
  sleepContext: SleepContext,
  currentLevels: ProfileLevels,
  todayKey: string,
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

  // The loop is scored on the THERMAL score, not the overall one. Measured on
  // this data 2026-08-23..29, the overall score correlated +0.67 with time
  // asleep and −0.38 with deep sleep, so optimising it steered away from the
  // very thing the bed is for. Nights with no thermal score (Apple Health, or
  // the /trends fallback) cannot judge a profile and are left out.
  const scoredNights = sleepContext.nights
    .filter((night) => night.thermalScore != null)
    .sort((a, b) => a.date.localeCompare(b.date));

  const driven = await drivenNights(email);
  const hold = await stagesLockedByRecentChanges(email, todayKey);

  const result: ExperimentHistory = {
    historyLines: [],
    bestProfile: null,
    bestScore: null,
    verifiedNights: 0,
    unverifiedNights: 0,
    lockedStages: [],
    nightsOnCurrentProfile: 0,
    ledger: [],
    pressure: [],
    lockDirection: {},
    lastChangeNight: null,
  };
  result.lockedStages = hold.locked;
  result.nightsOnCurrentProfile = hold.heldNights;
  result.lockDirection = hold.lockDirection;
  result.lastChangeNight = hold.lastChangeNight;
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
    score: night.thermalScore!,
    overall: night.score,
    profile: profileForNight(night.date),
    verified: driven.has(night.date),
  }));

  result.lockedStages = hold.locked;
  result.nightsOnCurrentProfile = hold.heldNights;
  result.verifiedNights = nightsWithProfiles.filter((n) => n.verified).length;
  result.unverifiedNights = nightsWithProfiles.length - result.verifiedNights;

  // "Best profile" and the revert guardrail only ever consider nights the
  // pod provably ran our schedule. Attributing a score to settings that were
  // never applied is worse than having no history at all, because it moves
  // the profile with confidence in an arbitrary direction.
  const usable = nightsWithProfiles.filter((n) => n.verified);
  let bestDate: string | null = null;
  if (usable.length > 0) {
    let best = usable[0]!;
    for (const night of usable) {
      if (night.score > best.score) best = night;
    }
    result.bestProfile = best.profile;
    result.bestScore = best.score;
    bestDate = best.date;

  }

  const scored: ScoredNight[] = nightsWithProfiles.map((night) => ({
    date: night.date,
    thermalScore: night.score,
    overallScore: night.overall,
    profile: night.profile,
    verified: night.verified,
  }));
  result.ledger = buildLedger(scored, currentLevels);

  // Live tuning's own record over the nights it could have acted on.
  const recentNightKeys = scored.slice(-3).map((night) => {
    const start = new Date(`${night.date}T12:00:00Z`);
    start.setUTCDate(start.getUTCDate() - 1);
    return start.toISOString().slice(0, 10);
  });
  try {
    const adjustments = await db
      .select()
      .from(aiLiveAdjustments)
      .where(eq(aiLiveAdjustments.email, email))
      .orderBy(aiLiveAdjustments.id)
      .limit(60);
    result.pressure = livePressure(
      adjustments.map((a) => ({
        night: a.night,
        stage: a.stage,
        newOffset: a.newOffset,
      })),
      recentNightKeys,
    );
  } catch (error) {
    console.error(
      `Could not read live-tuning pressure for ${email}:`,
      error instanceof Error ? error.message : String(error),
    );
  }

  result.historyLines = nightsWithProfiles
    .slice(-7)
    .reverse()
    .map(
      (night) =>
        `${night.date}: thermal ${night.score}${night.overall != null ? ` (overall ${night.overall})` : ""} at ${formatProfileC(night.profile)}` +
        (night.date === bestDate ? " (best night)" : "") +
        (night.verified
          ? ""
          : " — NOT COMPARABLE: the scheduler was down, so these temperatures were not actually applied; use this night's score only as a general data point, never as evidence for or against a profile"),
    );

  return result;
}

/**
 * The experiment ledger for the app, built from the database alone (night
 * metrics, the recommendation trail and the temperature events) so a page
 * load never has to call Eight Sleep. Same grouping the advisor reasons over,
 * so what the app shows and what the loop believes cannot drift apart.
 */
export async function readLedgerForApp(
  email: string,
  currentLevels: ProfileLevels,
): Promise<{ ledger: LedgerEntry[]; pressure: LivePressure[] }> {
  const [metrics, driven, appliedRecs, adjustments] = await Promise.all([
    readNightMetrics(
      email,
      shiftDate(new Date().toISOString().slice(0, 10), -21),
      new Date().toISOString().slice(0, 10),
    ),
    drivenNights(email),
    db
      .select()
      .from(aiRecommendations)
      .where(
        and(
          eq(aiRecommendations.email, email),
          inArray(aiRecommendations.status, ["applied", "auto_applied"]),
        ),
      )
      .orderBy(aiRecommendations.forDate)
      .limit(60),
    db
      .select()
      .from(aiLiveAdjustments)
      .where(eq(aiLiveAdjustments.email, email))
      .orderBy(aiLiveAdjustments.id)
      .limit(60),
  ]);

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
    return active ?? currentLevels;
  };

  const scored: ScoredNight[] = metrics
    .filter((m) => m.thermalScore != null)
    .map((m) => ({
      date: m.night,
      thermalScore: m.thermalScore!,
      overallScore: m.score,
      profile: profileForNight(m.night),
      verified: driven.has(m.night),
    }));

  const recentNights = scored.slice(-3).map((night) => shiftDate(night.date, -1));
  return {
    ledger: buildLedger(scored, currentLevels),
    pressure: livePressure(
      adjustments.map((a) => ({
        night: a.night,
        stage: a.stage,
        newOffset: a.newOffset,
      })),
      recentNights,
    ),
  };
}

const FELT_LABEL: Record<string, string> = {
  too_hot: "too hot",
  too_cold: "too cold",
  just_right: "about right",
};
const WHEN_LABEL: Record<string, string> = {
  falling_asleep: "while falling asleep",
  middle: "in the middle of the night",
  morning: "towards morning",
  all_night: "all night",
};
const WHEN_STAGE: Record<string, Stage> = {
  falling_asleep: "initial",
  middle: "mid",
  morning: "final",
  // The prompt only offers three windows, because nobody knows which third of
  // the night was their deep-sleep block. A hand adjustment does know — the
  // schedule was mid-stage at the time — so it records the true stage rather
  // than rounding it to the nearest thing a human could have said.
  deep: "deep",
};

/**
 * When the sleeper says "too hot" but cannot say WHEN, the night can. For a
 * too-hot report, pick the third where they turned over most AND the bed ran
 * warmest; for too-cold, most restless and coolest. Nobody should have to
 * remember which third of the night they were uncomfortable in — that is the
 * one thing the pod is better at than they are.
 */
function inferStage(
  direction: "cooler" | "warmer",
  tosses: { firstThird: number | null; middleThird: number | null; finalThird: number | null },
  bedTemp: { firstThird: number | null; middleThird: number | null; finalThird: number | null },
): Stage | null {
  const thirds: { stage: Stage; toss: number | null; temp: number | null }[] = [
    { stage: "deep", toss: tosses.firstThird, temp: bedTemp.firstThird },
    { stage: "mid", toss: tosses.middleThird, temp: bedTemp.middleThird },
    { stage: "final", toss: tosses.finalThird, temp: bedTemp.finalThird },
  ];
  const withToss = thirds.filter((t) => t.toss != null);
  if (withToss.length === 0) return null;

  const maxToss = Math.max(...withToss.map((t) => t.toss!));
  if (maxToss === 0) return null;
  // Only the thirds that were genuinely restless are candidates.
  const candidates = withToss.filter((t) => t.toss! >= maxToss * 0.8);
  if (candidates.length === 1) return candidates[0]!.stage;

  // Tie-break on temperature in the direction the sleeper described.
  const withTemp = candidates.filter((t) => t.temp != null);
  if (withTemp.length === 0) return candidates[0]!.stage;
  return withTemp.reduce((best, entry) =>
    direction === "cooler"
      ? entry.temp! > best.temp!
        ? entry
        : best
      : entry.temp! < best.temp!
        ? entry
        : best,
  ).stage;
}

/**
 * What the sleeper actually reported. Everything else the loop reads is a
 * proxy — tossing stands in for discomfort, heart rate stands in for being too
 * warm — so a plain "it was too hot towards morning" is the highest-quality
 * evidence available and is treated as such: it can move a stage on its own.
 */
async function readComfort(
  email: string,
  todayKey: string,
  thirds: {
    tosses: { firstThird: number | null; middleThird: number | null; finalThird: number | null };
    bedTemp: { firstThird: number | null; middleThird: number | null; finalThird: number | null };
  },
): Promise<{
  lines: string[];
  /** A stage the sleeper has reported the same way on 2+ of the last 3 nights. */
  consistent: {
    stage: Stage;
    direction: "cooler" | "warmer";
    nights: number;
    /** The most recent night this was reported about. */
    latestNight: string;
  } | null;
}> {
  try {
    const rows = await db
      .select()
      .from(sleepFeedback)
      .where(eq(sleepFeedback.email, email))
      .orderBy(desc(sleepFeedback.night))
      .limit(3);
    if (rows.length === 0) return { lines: [], consistent: null };

    const lines = rows.map(
      (row) =>
        `${row.night}: reported ${FELT_LABEL[row.felt] ?? row.felt}${row.whenFelt ? ` ${WHEN_LABEL[row.whenFelt] ?? row.whenFelt}` : ""}${row.note ? ` — "${row.note}"` : ""}`,
    );

    const votes = new Map<string, number>();
    for (const row of rows) {
      if (row.felt === "just_right") continue;
      const direction = row.felt === "too_hot" ? "cooler" : "warmer";
      // "Not sure" and "all night" carry no stage, so the night supplies one:
      // the third they were most restless in, broken by temperature in the
      // direction they described.
      const stage =
        (row.whenFelt ? WHEN_STAGE[row.whenFelt] : undefined) ??
        inferStage(direction, thirds.tosses, thirds.bedTemp);
      if (!stage) continue;
      const key = `${stage}|${direction}`;
      votes.set(key, (votes.get(key) ?? 0) + 1);
    }
    const latestNight = rows[0]!.night;
    let consistent: {
      stage: Stage;
      direction: "cooler" | "warmer";
      nights: number;
      latestNight: string;
    } | null = null;
    for (const [key, count] of votes) {
      // ONE report is enough. Requiring two nights is the right bar for a
      // signal INFERRED from movement; when the sleeper states it outright,
      // making them say it twice before anything happens is just ignoring
      // them for a night.
      if (count < 1) continue;
      const [stage, direction] = key.split("|") as [Stage, "cooler" | "warmer"];
      if (!consistent || count > consistent.nights) {
        consistent = { stage, direction, nights: count, latestNight };
      }
    }
    void todayKey;
    return { lines, consistent };
  } catch (error) {
    console.error(
      `Could not read sleep feedback for ${email}:`,
      error instanceof Error ? error.message : String(error),
    );
    return { lines: [], consistent: null };
  }
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
  const todayKey = new Date().toLocaleDateString("en-CA", {
    timeZone: profile.timezoneTZ,
  });
  const history = await buildExperimentHistory(
    email,
    sleepContext,
    currentLevels,
    todayKey,
  );

  const unit: DisplayUnit =
    settings.displayUnit === "level" ? "level" : "celsius";
  const fmt = (raw: number) => formatRawByUnit(raw, unit);
  const comfortSession = sleepContext.recentSessions[0];
  const comfort = await readComfort(email, todayKey, {
    tosses: comfortSession?.tossesAndTurns ?? {
      firstThird: null,
      middleThird: null,
      finalThird: null,
    },
    bedTemp: comfortSession?.avgBedTempC ?? {
      firstThird: null,
      middleThird: null,
      finalThird: null,
    },
  });
  // The measurements the explanation cites, per stage, from last night.
  const session = sleepContext.recentSessions[0];
  const thirdFor = (stage: Stage) =>
    stage === "initial" || stage === "deep"
      ? ("firstThird" as const)
      : stage === "mid"
        ? ("middleThird" as const)
        : ("finalThird" as const);
  const tossesAt = (stage: Stage) =>
    session?.tossesAndTurns[thirdFor(stage)] ?? null;
  const bedTempAt = (stage: Stage) =>
    session?.avgBedTempC[thirdFor(stage)] ?? null;
  const decision = decide({
    current: currentLevels,
    ledger: history.ledger,
    pressure: history.pressure,
    lockedStages: history.lockedStages as Stage[],
    lockDirection: history.lockDirection,
    verifiedNights: history.verifiedNights,
    nightsOnCurrentProfile: history.nightsOnCurrentProfile,
    maxShiftC: settings.maxDailyShift / 10,
  });

  let recommendation: AiRecommendation;
  const reported = comfort.consistent;
  // A hold exists to let an experiment RUN. A report about a night the held
  // change actually ran on IS that experiment's result — "still too hot after
  // you cooled it" is the answer, not noise to wait through. The hold only
  // survives when the report predates the change it is protecting.
  const heldSince = history.lastChangeNight;
  const reportedLocked =
    reported != null &&
    history.lockedStages.includes(reported.stage) &&
    history.lockDirection[reported.stage] === reported.direction &&
    heldSince != null &&
    reported.latestNight < heldSince;

  if (reported && !reportedLocked) {
    // The sleeper said the same thing about the same stage on two of the last
    // three nights. No inferred signal outranks that, so it moves first.
    const step = Math.min(0.5, settings.maxDailyShift / 10);
    const fromC = rawToCelsius(currentLevels[reported.stage]);
    const toC =
      Math.round((fromC + (reported.direction === "cooler" ? -step : step)) * 10) /
      10;
    const next: Record<Stage, number> = {
      initial: rawToCelsius(currentLevels.initial),
      deep: rawToCelsius(currentLevels.deep),
      mid: rawToCelsius(currentLevels.mid),
      final: rawToCelsius(currentLevels.final),
    };
    next[reported.stage] = toC;
    const label = STAGE_LABELS[reported.stage];
    recommendation = {
      initialSleepC: next.initial,
      deepSleepC: next.deep,
      midStageSleepC: next.mid,
      finalSleepC: next.final,
      reasoning: `${mechanism(reported.stage, reported.direction)} ${observation({
        stage: reported.stage,
        direction: reported.direction,
        tosses: tossesAt(reported.stage),
        bedTempC: bedTempAt(reported.stage),
        liveNights: null,
        reportedNights: reported.nights,
      })} What you report beats anything inferred from movement, so the ${STAGE_NAME[reported.stage]} stage goes ${reported.direction} tonight: ${fmt(currentLevels[reported.stage])} to ${fmt(celsiusToRaw(toC))}. Nothing else moves.`,
      confidence: reported.nights >= 3 ? "high" : "medium",
      perStage: STAGES.map((stage) => ({
        stage,
        direction:
          stage !== reported.stage ? ("unchanged" as const) : reported.direction,
        why:
          stage === reported.stage
            ? `${mechanism(stage, reported.direction)} You reported it on ${reported.nights} of the last 3 nights.`
            : `Held steady so the ${STAGE_NAME[reported.stage]} change can be judged on its own.`,
      })),
      evidence: comfort.lines,
      expectation: `You should not report the ${label} stage being too ${reported.direction === "cooler" ? "warm" : "cold"} tomorrow. If you do, it needs to move further.`,
      principle: principleFor(reported.stage, reported.direction),
      forecast: forecastFromLedger(history.ledger),
    };
  } else if (decision.kind === "fold-live") {
    // The strongest evidence there is: live tuning had to correct this stage
    // the same way on most of the recent nights, so the base is wrong and we
    // know both the direction and roughly the size.
    const next: Record<Stage, number> = {
      initial: rawToCelsius(currentLevels.initial),
      deep: rawToCelsius(currentLevels.deep),
      mid: rawToCelsius(currentLevels.mid),
      final: rawToCelsius(currentLevels.final),
    };
    next[decision.stage] = decision.toC;
    const cooler = decision.toC < decision.fromC;
    const label = STAGE_LABELS[decision.stage];
    recommendation = {
      initialSleepC: next.initial,
      deepSleepC: next.deep,
      midStageSleepC: next.mid,
      finalSleepC: next.final,
      reasoning: `${mechanism(decision.stage, cooler ? "cooler" : "warmer")} ${observation({
        stage: decision.stage,
        direction: cooler ? "cooler" : "warmer",
        tosses: tossesAt(decision.stage),
        bedTempC: bedTempAt(decision.stage),
        liveNights: decision.pressure.nights,
        reportedNights: null,
      })} So the ${STAGE_NAME[decision.stage]} stage starts ${Math.abs(decision.toC - decision.fromC).toFixed(1)}°C ${cooler ? "cooler" : "warmer"} tonight — ${fmt(currentLevels[decision.stage])} to ${fmt(celsiusToRaw(decision.toC))} — rather than waiting to be corrected again once you are already asleep. Nothing else moves, so the effect of this one change can be measured.`,
      confidence: decision.pressure.nights >= 3 ? "high" : "medium",
      perStage: STAGES.map((stage) => ({
        stage,
        direction:
          stage !== decision.stage
            ? ("unchanged" as const)
            : cooler
              ? ("cooler" as const)
              : ("warmer" as const),
        why:
          stage === decision.stage
            ? `${mechanism(stage, cooler ? "cooler" : "warmer")} ${observation({
                stage,
                direction: cooler ? "cooler" : "warmer",
                tosses: tossesAt(stage),
                bedTempC: bedTempAt(stage),
                liveNights: decision.pressure.nights,
                reportedNights: null,
              })}`
            : `Held steady so the ${STAGE_NAME[decision.stage]} change can be judged on its own — two stages moving at once cannot be told apart afterwards.`,
      })),
      evidence: [
        `Live tuning corrected the ${label} stage on ${decision.pressure.nights} of the last 3 nights.`,
        `Average correction ${decision.pressure.meanOffsetC.toFixed(1)}°C, always the same direction.`,
      ],
      expectation: `Fewer turns during ${where(decision.stage)}, and the pod should not need to correct itself mid-night. If it corrects just as hard again, this stage has further to move.`,
      principle: principleFor(decision.stage, cooler ? "cooler" : "warmer"),
      forecast: forecastFromLedger(history.ledger),
    };
  } else if (decision.kind === "converged" || decision.kind === "hold") {
    // Someone who reported discomfort and then reads "nothing worth changing"
    // has been told their report was ignored. It was not — it predates the
    // change now being measured — but only saying so makes that true to read.
    const acknowledgement =
      reported && reportedLocked
        ? `You reported the bed felt too ${reported.direction === "cooler" ? "hot" : "cold"} during the ${STAGE_NAME[reported.stage]} stage. That is exactly what last night's change was for — the ${STAGE_NAME[reported.stage]} stage was already moved ${reported.direction} — and tonight measures whether it went far enough. If it still feels wrong in the morning, say so again and it moves further. `
        : "";
    const why =
      acknowledgement +
      (decision.kind === "converged"
        ? `This profile is averaging a thermal score of ${decision.meanThermal} over ${decision.nights} measured night${decision.nights === 1 ? "" : "s"}, level with the best you have recorded. There is nothing here worth changing tonight, and changing it anyway would only add noise.`
        : decision.reason);
    recommendation = {
      initialSleepC: rawToCelsius(currentLevels.initial),
      deepSleepC: rawToCelsius(currentLevels.deep),
      midStageSleepC: rawToCelsius(currentLevels.mid),
      finalSleepC: rawToCelsius(currentLevels.final),
      reasoning: why,
      confidence: decision.kind === "converged" ? "high" : "medium",
      perStage: STAGES.map((stage) => ({
        stage,
        direction: "unchanged" as const,
        why: "Held steady tonight.",
      })),
      evidence: history.ledger
        .slice(0, 3)
        .map(
          (entry) =>
            `${STAGES.map((st) => fmt(entry.profile[st])).join("/")}: thermal ${entry.meanThermal} over ${entry.nights.length} night${entry.nights.length === 1 ? "" : "s"}.`,
        ),
      expectation:
        decision.kind === "converged"
          ? "Tonight should look like the last few — that is the point."
          : "Another night on the same settings, so the last change can be judged.",
      principle:
        "A controller with no stopping condition oscillates forever. Not changing anything is a decision, and often the right one.",
      forecast: forecastFromLedger(history.ledger),
    };
  } else {
    const signals = [
      ...deriveNightSignals(sleepContext),
      ...(await buildLiveTuningSignals(email)),
      ...(comfort.lines.length > 0
        ? [
            "How the sleeper said it FELT (their own words — this outranks anything inferred from tossing or heart rate):",
            ...comfort.lines,
          ]
        : []),
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
      // The ledger is what the loop has actually LEARNED: every profile
      // tried, how many measured nights it got, and what it averaged. Seven
      // loose "date: score" lines were never enough to reason from.
      ledgerLines: describeLedger(history.ledger, fmt),
      sleepGoal: settings.sleepGoal,
      maxDailyShiftC: settings.maxDailyShift / 10,
      lockedStages: history.lockedStages,
      nightsOnCurrentProfile: history.nightsOnCurrentProfile,
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
        forecast: recommendation.forecast ?? null,
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

/**
 * Single-flight guard for the daily pass. Postgres advisory locks are held for
 * the session and released automatically when it ends, so a crashed run cannot
 * wedge tomorrow's. The key is derived from the user and the date, so two
 * different users never block each other.
 */
async function claimDailyPass(email: string, forDate: string): Promise<boolean> {
  try {
    const rows = await db.execute<{ locked: boolean }>(
      sql`select pg_try_advisory_lock(hashtext(${`8slp:daily:${email}:${forDate}`})) as locked`,
    );
    const row = (rows as unknown as { rows?: { locked: boolean }[] }).rows?.[0];
    return row?.locked ?? true;
  } catch (error) {
    // A lock we cannot take is not a reason to skip the night's work; the
    // duplicate check above still catches the common case.
    console.error(
      `Advisory lock unavailable for ${email}:`,
      error instanceof Error ? error.message : String(error),
    );
    return true;
  }
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

/**
 * Heartbeat so "the cron never fired" is distinguishable from "it fired and
 * the pass failed". Written on every tick, read by /api/aiStatus.
 *
 * `source` records WHICH scheduler called. With more than one caller (a NAS
 * job plus a laptop fallback) a single timestamp hides the death of the
 * primary behind the fallback — the same masking that hid a whole missed day
 * on 2026-08-24.
 */
export async function recordCronHeartbeat(source?: string | null): Promise<void> {
  try {
    const at = new Date().toISOString();
    const clean = (source ?? "unknown").replace(/[^a-z0-9_-]/gi, "").slice(0, 24);
    await db
      .insert(appConfig)
      .values({ key: "cron:lastRunAt", value: at })
      .onConflictDoUpdate({
        target: appConfig.key,
        set: { value: at },
      });
    await db
      .insert(appConfig)
      .values({ key: "cron:lastSource", value: clean })
      .onConflictDoUpdate({
        target: appConfig.key,
        set: { value: clean },
      });
    await db
      .insert(appConfig)
      .values({ key: `cron:lastRunAt:${clean}`, value: at })
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
      // Refresh the cached night metrics for this user. Without this the
      // cache is only written when someone OPENS the app, so a second
      // account's stored quality scores stayed null indefinitely and its
      // ledger had nothing to reason over.
      try {
        const user = await db.query.users.findFirst({
          where: eq(users.email, email),
        });
        if (user) {
          const token = await getFreshToken(user);
          await syncNightMetrics(
            email,
            token,
            user.eightUserId,
            profile.timezoneTZ,
            1,
          );
        }
      } catch (error) {
        console.error(
          `Night-metric refresh failed for ${email}:`,
          error instanceof Error ? error.message : String(error),
        );
      }

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

      // Two schedulers (the NAS timer and the laptop fallback) both fire on
      // the hour, and this check-then-insert has no lock between them: on
      // 2026-08-26..29 that produced TWO recommendations per day per user,
      // each auto-applied, so the second's "previous" was the first's
      // recommendation and the experiment history recorded a change that
      // never had a night. An advisory lock makes the pass single-flight;
      // whoever loses simply skips, because the winner is doing the work.
      const claimed = await claimDailyPass(email, forDate);
      if (!claimed) {
        console.log(`Daily pass for ${email} already running elsewhere; skipping.`);
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
