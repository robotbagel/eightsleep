// aiStatus: read-only monitoring endpoint for the AI Autopilot, guarded by
// the same CRON_SECRET as the temperature cron. Reports, per user, whether
// the loop is doing its job: settings, latest recommendation and its
// reasoning, recommendation counts, recent live adjustments, and the recent
// night scores the advisor saw. DB-only on purpose — it never calls the
// Eight Sleep or Gemini APIs, so polling it is free and side-effect-less.
import type { NextRequest } from "next/server";
import { db } from "~/server/db";
import {
  aiLiveAdjustments,
  aiRecommendations,
  aiRunLog,
  sleepFeedback,
  temperatureEvents,
  userAiSettings,
  userTemperatureProfile,
  users,
} from "~/server/db/schema";
import { desc, eq, like } from "drizzle-orm";
import { isAiConfigured, GEMINI_MODEL } from "~/server/ai/gemini";
import { readNightMetrics, shiftDate } from "~/server/ai/history";
import { rawToCelsius } from "~/lib/temperature";
import { appConfig, healthNights } from "~/server/db/schema";
import { desc as descOrder } from "drizzle-orm";

export const runtime = "nodejs";

function parseRationale(json: string | null): {
  stages: number;
  evidence: number;
  hasExpectation: boolean;
  hasPrinciple: boolean;
  principle: string | null;
  forecast: { expectedScoreLow?: number; expectedScoreHigh?: number } | null;
} | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as {
      perStage?: unknown[];
      evidence?: unknown[];
      expectation?: string;
      principle?: string;
      forecast?: {
        expectedScoreLow?: number;
        expectedScoreHigh?: number;
      } | null;
    };
    return {
      stages: parsed.perStage?.length ?? 0,
      evidence: parsed.evidence?.length ?? 0,
      hasExpectation: !!parsed.expectation,
      hasPrinciple: !!parsed.principle,
      principle: parsed.principle ?? null,
      forecast: parsed.forecast ?? null,
    };
  } catch {
    return null;
  }
}

interface StoredNight {
  date?: string;
  score?: number | null;
}

export async function GET(request: NextRequest): Promise<Response> {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    const allUsers = await db.select().from(users);
    const report = [];

    for (const user of allUsers) {
      const email = user.email;
      const settings = await db.query.userAiSettings.findFirst({
        where: eq(userAiSettings.email, email),
      });
      const profile = await db.query.userTemperatureProfile.findFirst({
        where: eq(userTemperatureProfile.email, email),
      });
      const recommendations = await db
        .select()
        .from(aiRecommendations)
        .where(eq(aiRecommendations.email, email))
        .orderBy(desc(aiRecommendations.id))
        .limit(30);
      // Did the pod actually get driven on each night, or was the app only
      // ever reporting on sleep it had no hand in? One row per stage change
      // we sent, so an empty night means the schedule never ran.
      const events = await db
        .select()
        .from(temperatureEvents)
        .where(eq(temperatureEvents.email, email))
        .orderBy(desc(temperatureEvents.id))
        .limit(400);
      const nightsDriven: Record<
        string,
        { scheduled: number; live: number; off: number; stages: string[] }
      > = {};
      for (const event of events) {
        const bucket = (nightsDriven[event.night] ??= {
          scheduled: 0,
          live: 0,
          off: 0,
          stages: [],
        });
        if (event.source === "live") bucket.live += 1;
        else if (event.source === "off") bucket.off += 1;
        else {
          bucket.scheduled += 1;
          if (!bucket.stages.includes(event.stage)) bucket.stages.push(event.stage);
        }
      }

      const feedback = await db
        .select()
        .from(sleepFeedback)
        .where(eq(sleepFeedback.email, email))
        .orderBy(desc(sleepFeedback.night))
        .limit(5);

      const storedNights = await readNightMetrics(
        email,
        shiftDate(new Date().toISOString().slice(0, 10), -9),
        new Date().toISOString().slice(0, 10),
      );

      const runs = await db
        .select()
        .from(aiRunLog)
        .where(eq(aiRunLog.email, email))
        .orderBy(desc(aiRunLog.id))
        .limit(8);
      const liveAdjustments = await db
        .select()
        .from(aiLiveAdjustments)
        .where(eq(aiLiveAdjustments.email, email))
        .orderBy(desc(aiLiveAdjustments.id))
        .limit(10);

      const latest = recommendations[0];
      let recentScores: StoredNight[] = [];
      if (latest?.sleepContextJson) {
        try {
          const context = JSON.parse(latest.sleepContextJson) as {
            nights?: StoredNight[];
          };
          recentScores = (context.nights ?? []).map((night) => ({
            date: night.date,
            score: night.score ?? null,
          }));
        } catch {
          // stored context unreadable; scores stay empty
        }
      }

      const counts: Record<string, number> = {};
      for (const rec of recommendations) {
        counts[rec.status] = (counts[rec.status] ?? 0) + 1;
      }

      const latestHealth = await db
        .select()
        .from(healthNights)
        .where(eq(healthNights.email, email))
        .orderBy(descOrder(healthNights.night))
        .limit(1);
      const hn = latestHealth[0];
      const rawRow =
        request.nextUrl.searchParams.get("raw") === "1"
          ? await db.query.appConfig.findFirst({
              where: eq(appConfig.key, `lastRaw:${email}`),
            })
          : null;

      report.push({
        email,
        lastRawSamples: rawRow?.value ?? null,
        latestHealthNight: hn
          ? {
              night: hn.night,
              asleepH: hn.asleepTenthHours / 10,
              deepH: hn.deepTenthHours != null ? hn.deepTenthHours / 10 : null,
              remH: hn.remTenthHours != null ? hn.remTenthHours / 10 : null,
              coreH: hn.coreTenthHours != null ? hn.coreTenthHours / 10 : null,
              awakeH: hn.awakeTenthHours != null ? hn.awakeTenthHours / 10 : null,
              wakeCount: hn.wakeCount,
              score: hn.score,
            }
          : null,
        // Last 4 chars of the Eight Sleep user id: proof each app account
        // drives a distinct Eight identity (and therefore a distinct side).
        eightUserIdSuffix: user.eightUserId.slice(-4),
        settings: settings
          ? {
              aiEnabled: settings.aiEnabled,
              autoApply: settings.autoApply,
              liveTuningEnabled: settings.liveTuningEnabled,
              // The monitor formats temperatures in the unit the sleeper
              // actually sees in the app; reporting °C to someone whose app
              // shows -10..+10 sliders makes every number unrecognisable.
              displayUnit: settings.displayUnit,
              maxDailyShiftC: settings.maxDailyShift / 10,
              sleepGoal: settings.sleepGoal,
              updatedAt: settings.updatedAt,
            }
          : null,
        profileC: profile
          ? {
              bedTime: profile.bedTime.slice(0, 5),
              wakeupTime: profile.wakeupTime.slice(0, 5),
              timezone: profile.timezoneTZ,
              initialC: rawToCelsius(profile.initialSleepLevel),
              deepC: rawToCelsius(
                profile.deepSleepLevel ?? profile.midStageSleepLevel,
              ),
              midC: rawToCelsius(profile.midStageSleepLevel),
              finalC: rawToCelsius(profile.finalSleepLevel),
              updatedAt: profile.updatedAt,
            }
          : null,
        nightsDriven,
        // The STORED per-night scores. A night's numbers must never move once
        // recorded; polling this across a cron tick is how that is checked
        // rather than asserted.
        // What the sleeper reported, so "I answered and nothing happened" is
        // checkable rather than a matter of opinion.
        feedback: feedback.map((f) => ({
          night: f.night,
          felt: f.felt,
          whenFelt: f.whenFelt,
          note: f.note,
        })),
        storedNights: storedNights.map((n) => ({
          night: n.night,
          score: n.score,
          quality: n.thermalScore,
        })),
        // The decision trail, so oscillation (moving a stage down then back
        // up on successive days) is visible instead of having to be inferred
        // from one latest recommendation.
        recommendationHistory: recommendations.slice(0, 14).map((rec) => ({
          forDate: rec.forDate,
          status: rec.status,
          confidence: rec.confidence,
          fromC: {
            initial: rawToCelsius(rec.previousInitialLevel),
            deep: rawToCelsius(rec.previousDeepLevel ?? rec.previousMidLevel),
            mid: rawToCelsius(rec.previousMidLevel),
            final: rawToCelsius(rec.previousFinalLevel),
          },
          toC: {
            initial: rawToCelsius(rec.recommendedInitialLevel),
            deep: rawToCelsius(rec.recommendedDeepLevel ?? rec.recommendedMidLevel),
            mid: rawToCelsius(rec.recommendedMidLevel),
            final: rawToCelsius(rec.recommendedFinalLevel),
          },
        })),
        // Why a day is missing: whether the pass was attempted at all, and
        // what it said if it failed.
        dailyPassRuns: runs.map((run) => ({
          forDate: run.forDate,
          at: run.at,
          phase: run.phase,
          ok: run.ok,
          detail: run.detail,
        })),
        latestRecommendation: latest
          ? {
              forDate: latest.forDate,
              status: latest.status,
              source: latest.source,
              confidence: latest.confidence,
              previousC: {
                initial: rawToCelsius(latest.previousInitialLevel),
                deep: rawToCelsius(
                  latest.previousDeepLevel ?? latest.previousMidLevel,
                ),
                mid: rawToCelsius(latest.previousMidLevel),
                final: rawToCelsius(latest.previousFinalLevel),
              },
              recommendedC: {
                initial: rawToCelsius(latest.recommendedInitialLevel),
                deep: rawToCelsius(
                  latest.recommendedDeepLevel ?? latest.recommendedMidLevel,
                ),
                mid: rawToCelsius(latest.recommendedMidLevel),
                final: rawToCelsius(latest.recommendedFinalLevel),
              },
              reasoning: latest.reasoning,
              // The structured "why" the app shows. Reported here so the
              // daily monitor can tell an empty rationale (a silently
              // degraded model response) from a healthy one.
              rationale: parseRationale(latest.rationaleJson),
              createdAt: latest.createdAt,
            }
          : null,
        recommendationCounts: counts,
        liveAdjustments: liveAdjustments.map((adjustment) => ({
          night: adjustment.night,
          stage: adjustment.stage,
          deltaC: adjustment.offsetDelta / 10,
          netOffsetC: adjustment.newOffset / 10,
          appliedC: rawToCelsius(adjustment.appliedLevel),
          reason: adjustment.reason,
          at: adjustment.createdAt,
        })),
        recentScores,
      });
    }

    // The heartbeat separates "the external cron stopped calling us" from
    // "the cron ran and the pass failed" — two very different problems that
    // used to produce the same symptom.
    let cronLastRunAt: string | null = null;
    let cronLastSource: string | null = null;
    // Per-caller timestamps, so a healthy fallback cannot hide a dead primary.
    const cronSources: Record<string, number> = {};
    try {
      const rows = await db
        .select()
        .from(appConfig)
        .where(like(appConfig.key, "cron:%"));
      for (const row of rows) {
        if (row.key === "cron:lastRunAt") cronLastRunAt = row.value;
        else if (row.key === "cron:lastSource") cronLastSource = row.value;
        else if (row.key.startsWith("cron:lastRunAt:")) {
          const minutes = Math.round(
            (Date.now() - new Date(row.value).getTime()) / 60000,
          );
          // A one-off or retired caller would otherwise sit in the status
          // line forever, growing staler and meaning nothing.
          if (minutes <= 6 * 60) {
            cronSources[row.key.slice("cron:lastRunAt:".length)] = minutes;
          }
        }
      }
    } catch {
      cronLastRunAt = null;
    }

    return Response.json({
      aiConfigured: isAiConfigured(),
      model: GEMINI_MODEL,
      generatedAt: new Date().toISOString(),
      cronLastRunAt,
      cronLastSource,
      /** Minutes since each scheduler last called, keyed by ?src=. */
      cronSourceStaleMinutes: cronSources,
      cronStaleMinutes:
        cronLastRunAt == null
          ? null
          : Math.round((Date.now() - new Date(cronLastRunAt).getTime()) / 60000),
      users: report,
    });
  } catch (error) {
    console.error(
      "aiStatus failed:",
      error instanceof Error ? error.message : String(error),
    );
    return new Response("Internal server error", { status: 500 });
  }
}
