// aiDebug: CRON_SECRET-guarded diagnostic for the AI data pipeline. Fetches
// the raw Eight Sleep trends and intervals responses per user (status + a
// truncated body) alongside the parsed sleep context, so schema/param
// mismatches can be diagnosed without guessing.
import type { NextRequest } from "next/server";
import { db } from "~/server/db";
import { users, userTemperatureProfile } from "~/server/db/schema";
import { eq } from "drizzle-orm";
import { getFreshToken } from "~/server/ai/advisor";
import { collectSleepContext } from "~/server/ai/sleepData";
import {
  APP_API_URL,
  CLIENT_API_URL,
  DEFAULT_API_HEADERS,
} from "~/server/eight/constants";

export const runtime = "nodejs";

async function rawProbe(
  url: string,
  accessToken: string,
): Promise<{ status: number; body: string }> {
  try {
    const response = await fetch(url, {
      headers: {
        ...DEFAULT_API_HEADERS,
        authorization: `Bearer ${accessToken}`,
      },
    });
    const body = await response.text();
    return { status: response.status, body: body.slice(0, 6000) };
  } catch (error) {
    return {
      status: 0,
      body: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function GET(request: NextRequest): Promise<Response> {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const report = [];
  const allUsers = await db.select().from(users);
  for (const user of allUsers) {
    try {
      const profile = await db.query.userTemperatureProfile.findFirst({
        where: eq(userTemperatureProfile.email, user.email),
      });
      const timezone = profile?.timezoneTZ ?? "UTC";
      const token = await getFreshToken(user);

      const search = request.nextUrl.searchParams;
      const to = new Date(Date.now() + 24 * 60 * 60 * 1000).toLocaleDateString(
        "en-CA",
        { timeZone: timezone },
      );
      const from = new Date(
        Date.now() - 7 * 24 * 60 * 60 * 1000,
      ).toLocaleDateString("en-CA", { timeZone: timezone });
      const params = new URLSearchParams({
        tz: timezone,
        from,
        to,
        "include-main": search.get("main") ?? "false",
        "include-all-sessions": search.get("all") ?? "false",
        "model-version": "v2",
      });

      const profileProbe = await rawProbe(
        `${CLIENT_API_URL}/users/me`,
        token.eightAccessToken,
      );
      let profileFlags: unknown = null;
      try {
        const parsed = JSON.parse(profileProbe.body) as {
          user?: Record<string, unknown>;
        };
        const u = parsed.user ?? {};
        profileFlags = {
          sleepTracking: u.sleepTracking ?? null,
          features: u.features ?? null,
          autopilotEnabled: u.autopilotEnabled ?? null,
          tempPreference: u.tempPreference ?? null,
          currentDevice: u.currentDevice ?? null,
          hotelGuest: u.hotelGuest ?? null,
        };
      } catch {
        profileFlags = { parseError: profileProbe.body.slice(0, 300) };
      }

      const trends = await rawProbe(
        `${CLIENT_API_URL}/users/${user.eightUserId}/trends?${params.toString()}`,
        token.eightAccessToken,
      );
      const intervals = await rawProbe(
        `${CLIENT_API_URL}/users/${user.eightUserId}/intervals`,
        token.eightAccessToken,
      );

      const context = await collectSleepContext(
        token,
        user.eightUserId,
        timezone,
      );

      const temperatureState = await rawProbe(
        `${APP_API_URL}v1/users/${user.eightUserId}/temperature`,
        token.eightAccessToken,
      );

      report.push({
        email: user.email,
        profileFlags,
        profileBody: profileProbe.body.slice(0, 2500),
        temperatureState: temperatureState.body.slice(0, 1200),
        trendsStatus: trends.status,
        trendsBody: trends.body,
        intervalsStatus: intervals.status,
        intervalsBody: intervals.body,
        parsedNights: context.nights.length,
        parsedSessions: context.recentSessions.length,
      });
    } catch (error) {
      report.push({
        email: user.email,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return Response.json({ generatedAt: new Date().toISOString(), users: report });
}
