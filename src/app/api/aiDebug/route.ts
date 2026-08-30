// aiDebug: CRON_SECRET-guarded diagnostic for the AI data pipeline. Fetches
// the raw Eight Sleep trends and intervals responses per user (status + a
// truncated body) alongside the parsed sleep context, so schema/param
// mismatches can be diagnosed without guessing.
import type { NextRequest } from "next/server";
import { db } from "~/server/db";
import { users, userTemperatureProfile } from "~/server/db/schema";
import { eq } from "drizzle-orm";
import { getFreshToken, reassessToday } from "~/server/ai/advisor";
import { sleepFeedback } from "~/server/db/schema";
import { and } from "drizzle-orm";
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
  limit = 6000,
): Promise<{ status: number; body: string }> {
  try {
    const response = await fetch(url, {
      headers: {
        ...DEFAULT_API_HEADERS,
        authorization: `Bearer ${accessToken}`,
      },
    });
    const body = await response.text();
    return { status: response.status, body: body.slice(0, limit) };
  } catch (error) {
    return {
      status: 0,
      body: error instanceof Error ? error.message : String(error),
    };
  }
}

// Operator action: void today's assessment for one user and regenerate it
// from current (corrected) data. POST /api/aiDebug?action=reassess&email=...
export async function POST(request: NextRequest): Promise<Response> {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  const action = request.nextUrl.searchParams.get("action");
  const email = request.nextUrl.searchParams.get("email");
  if (!email || (action !== "reassess" && action !== "comfort")) {
    return Response.json({ error: "Unknown action" }, { status: 400 });
  }

  // Operator path for a comfort report that reached us out of band — someone
  // telling their partner "I woke up freezing again" is the same evidence as
  // the in-app prompt, and the loop cannot act on what it never hears.
  // POST /api/aiDebug?action=comfort&email=…&night=YYYY-MM-DD&felt=too_cold&when=morning
  if (action === "comfort") {
    const night = request.nextUrl.searchParams.get("night");
    const felt = request.nextUrl.searchParams.get("felt");
    const when = request.nextUrl.searchParams.get("when");
    if (
      !night ||
      !/^\d{4}-\d{2}-\d{2}$/.test(night) ||
      (felt !== "too_hot" && felt !== "too_cold" && felt !== "just_right")
    ) {
      return Response.json(
        { error: "night=YYYY-MM-DD and felt=too_hot|too_cold|just_right required" },
        { status: 400 },
      );
    }
    await db
      .delete(sleepFeedback)
      .where(
        and(eq(sleepFeedback.email, email), eq(sleepFeedback.night, night)),
      );
    await db.insert(sleepFeedback).values({
      email,
      night,
      felt,
      whenFelt: when ?? "not_sure",
      note: "Reported out of band and entered by an operator.",
    });
    const rec = await reassessToday(email);
    return Response.json({
      success: true,
      recorded: { email, night, felt, whenFelt: when ?? "not_sure" },
      status: rec.status,
      confidence: rec.confidence,
      reasoning: rec.reasoning,
    });
  }

  try {
    const rec = await reassessToday(email);
    return Response.json({
      success: true,
      id: rec.id,
      forDate: rec.forDate,
      status: rec.status,
      confidence: rec.confidence,
      reasoning: rec.reasoning,
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

// Research probe: fetch an arbitrary Eight Sleep API path with the user's
// token, to map which endpoints still carry data without a subscription.
// Restricted to Eight Sleep hosts so this can't act as an open proxy.
// GET /api/aiDebug?probe=<path>&email=<user>   (path may contain {u} = userId,
// {d} = deviceId; host defaults to client-api, prefix "app:" for app-api)
async function handleProbe(
  request: NextRequest,
  rawPath: string,
): Promise<Response> {
  const email =
    request.nextUrl.searchParams.get("email") ?? "getnathan@outlook.com";
  const user = await db.query.users.findFirst({ where: eq(users.email, email) });
  if (!user) return Response.json({ error: "user not found" }, { status: 404 });
  const token = await getFreshToken(user);

  const profile = await db.query.userTemperatureProfile.findFirst({
    where: eq(userTemperatureProfile.email, email),
  });
  const timezone = profile?.timezoneTZ ?? "UTC";
  const me = await rawProbe(`${CLIENT_API_URL}/users/me`, token.eightAccessToken);
  let deviceId = "";
  try {
    deviceId =
      (JSON.parse(me.body) as { user?: { currentDevice?: { id?: string } } })
        .user?.currentDevice?.id ?? "";
  } catch {
    /* ignore */
  }

  const results = [];
  for (const entry of rawPath.split("|")) {
    let path = entry.trim();
    if (!path) continue;
    const useApp = path.startsWith("app:");
    if (useApp) path = path.slice(4);
    path = path
      .replace(/\{u\}/g, user.eightUserId)
      .replace(/\{d\}/g, deviceId)
      .replace(/\{tz\}/g, encodeURIComponent(timezone));
    const base = useApp ? APP_API_URL : `${CLIENT_API_URL}/`;
    const url = `${base}${path.replace(/^\//, "")}`;
    const res = await rawProbe(url, token.eightAccessToken, 400_000);
    if (request.nextUrl.searchParams.get("summary") === "1") {
      // Structural summary instead of the raw body: keys, array lengths, and
      // first/last samples — so large payloads can be mapped without
      // truncation.
      let shape: unknown = null;
      try {
        const describe = (value: unknown, depth = 0): unknown => {
          if (Array.isArray(value)) {
            return {
              array: value.length,
              first: depth < 3 ? describe(value[0], depth + 1) : "…",
              last: depth < 3 ? describe(value[value.length - 1], depth + 1) : "…",
            };
          }
          if (value && typeof value === "object") {
            const out: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(value)) {
              out[k] = depth < 3 ? describe(v, depth + 1) : typeof v;
            }
            return out;
          }
          return value;
        };
        shape = describe(JSON.parse(res.body));
      } catch (error) {
        shape = { parseError: String(error), head: res.body.slice(0, 300) };
      }
      results.push({ url, status: res.status, shape });
    } else {
      const cap =
        request.nextUrl.searchParams.get("full") === "1" ? 400_000 : 3000;
      results.push({ url, status: res.status, body: res.body.slice(0, cap) });
    }
  }
  return Response.json({ deviceId, results });
}

export async function GET(request: NextRequest): Promise<Response> {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const probe = request.nextUrl.searchParams.get("probe");
  if (probe) return handleProbe(request, probe);

  // Raw decision trail for one night: every temperature event and live
  // adjustment, exactly as stored. GET /api/aiDebug?events=YYYY-MM-DD&email=…
  // (night key = the date the night STARTED). This exists because diagnosing
  // a phantom override from summaries alone proved impossible.
  const eventsNight = request.nextUrl.searchParams.get("events");
  if (eventsNight) {
    const email = request.nextUrl.searchParams.get("email");
    if (!email) {
      return Response.json({ error: "email required" }, { status: 400 });
    }
    const { temperatureEvents, aiLiveAdjustments } = await import(
      "~/server/db/schema"
    );
    const { rawToCelsius } = await import("~/lib/temperature");
    const events = await db
      .select()
      .from(temperatureEvents)
      .where(
        and(
          eq(temperatureEvents.email, email),
          eq(temperatureEvents.night, eventsNight),
        ),
      )
      .orderBy(temperatureEvents.id);
    const adjustments = await db
      .select()
      .from(aiLiveAdjustments)
      .where(
        and(
          eq(aiLiveAdjustments.email, email),
          eq(aiLiveAdjustments.night, eventsNight),
        ),
      )
      .orderBy(aiLiveAdjustments.id);
    return Response.json({
      night: eventsNight,
      events: events.map((e) => ({
        id: e.id,
        at: e.at,
        stage: e.stage,
        level: e.level,
        levelC: e.level != null ? rawToCelsius(e.level) : null,
        source: e.source,
        note: e.note,
      })),
      adjustments: adjustments.map((a) => ({
        id: a.id,
        at: a.createdAt,
        stage: a.stage,
        offsetDelta: a.offsetDelta,
        newOffset: a.newOffset,
        appliedLevel: a.appliedLevel,
        appliedC: rawToCelsius(a.appliedLevel),
        reason: a.reason,
      })),
    });
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
        user.email,
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
