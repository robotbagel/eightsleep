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
  userAiSettings,
  userTemperatureProfile,
  users,
} from "~/server/db/schema";
import { desc, eq } from "drizzle-orm";
import { isAiConfigured, GEMINI_MODEL } from "~/server/ai/gemini";
import { rawToCelsius } from "~/lib/temperature";

export const runtime = "nodejs";

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

      report.push({
        email,
        settings: settings
          ? {
              aiEnabled: settings.aiEnabled,
              autoApply: settings.autoApply,
              liveTuningEnabled: settings.liveTuningEnabled,
              maxDailyShiftC: settings.maxDailyShift / 10,
              sleepGoal: settings.sleepGoal,
            }
          : null,
        profileC: profile
          ? {
              bedTime: profile.bedTime.slice(0, 5),
              wakeupTime: profile.wakeupTime.slice(0, 5),
              timezone: profile.timezoneTZ,
              initialC: rawToCelsius(profile.initialSleepLevel),
              midC: rawToCelsius(profile.midStageSleepLevel),
              finalC: rawToCelsius(profile.finalSleepLevel),
              updatedAt: profile.updatedAt,
            }
          : null,
        latestRecommendation: latest
          ? {
              forDate: latest.forDate,
              status: latest.status,
              source: latest.source,
              confidence: latest.confidence,
              previousC: {
                initial: rawToCelsius(latest.previousInitialLevel),
                mid: rawToCelsius(latest.previousMidLevel),
                final: rawToCelsius(latest.previousFinalLevel),
              },
              recommendedC: {
                initial: rawToCelsius(latest.recommendedInitialLevel),
                mid: rawToCelsius(latest.recommendedMidLevel),
                final: rawToCelsius(latest.recommendedFinalLevel),
              },
              reasoning: latest.reasoning,
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

    return Response.json({
      aiConfigured: isAiConfigured(),
      model: GEMINI_MODEL,
      generatedAt: new Date().toISOString(),
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
