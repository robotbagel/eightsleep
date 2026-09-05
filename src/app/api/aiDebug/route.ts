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
import { collectSleepContext, fetchPodSessions } from "~/server/ai/sleepData";
import { persistNightMetrics, sessionsToMetrics } from "~/server/ai/history";
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

  // Test cleanup: delete temperature events and live adjustments for one
  // night from a given moment onward, so a daytime end-to-end test of the
  // override detector leaves no trace in the history the nightly pass reads
  // (manual rows feed livePressure and would steer a real fold decision).
  // POST /api/aiDebug?action=prune&email=…&night=YYYY-MM-DD&after=<ISO>
  if (action === "prune") {
    const emailParam = request.nextUrl.searchParams.get("email");
    const night = request.nextUrl.searchParams.get("night");
    const after = request.nextUrl.searchParams.get("after");
    const afterDate = after ? new Date(after) : null;
    if (!emailParam || !night || !afterDate || isNaN(afterDate.getTime())) {
      return Response.json(
        { error: "email, night and after (ISO timestamp) required" },
        { status: 400 },
      );
    }
    const { temperatureEvents, aiLiveAdjustments } = await import(
      "~/server/db/schema"
    );
    const { gte } = await import("drizzle-orm");
    const deletedEvents = await db
      .delete(temperatureEvents)
      .where(
        and(
          eq(temperatureEvents.email, emailParam),
          eq(temperatureEvents.night, night),
          gte(temperatureEvents.at, afterDate),
        ),
      )
      .returning({ id: temperatureEvents.id });
    const deletedAdjustments = await db
      .delete(aiLiveAdjustments)
      .where(
        and(
          eq(aiLiveAdjustments.email, emailParam),
          eq(aiLiveAdjustments.night, night),
          gte(aiLiveAdjustments.createdAt, afterDate),
        ),
      )
      .returning({ id: aiLiveAdjustments.id });
    // Overrides during a test also plant sleepFeedback rows keyed to the
    // coming wake date ("Recorded from a hand adjustment..."), which the
    // next daily pass would read as a genuine comfort report. Only rows
    // carrying that exact provenance note are touched.
    const feedbackNights = (
      request.nextUrl.searchParams.get("feedbackNights") ?? ""
    )
      .split(",")
      .filter(Boolean);
    let prunedFeedback = 0;
    for (const fbNight of feedbackNights) {
      const gone = await db
        .delete(sleepFeedback)
        .where(
          and(
            eq(sleepFeedback.email, emailParam),
            eq(sleepFeedback.night, fbNight),
            eq(
              sleepFeedback.note,
              "Recorded from a hand adjustment made during the night.",
            ),
          ),
        )
        .returning({ id: sleepFeedback.id });
      prunedFeedback += gone.length;
    }
    return Response.json({
      prunedEvents: deletedEvents.length,
      prunedAdjustments: deletedAdjustments.length,
      prunedFeedback,
    });
  }
  // Disable Eight's leftover cloud-side temperature schedules. The official
  // app shows "Bedtime: Not set", yet the API carries an ENABLED daily
  // schedule (23:00:28, bedtime level -40 = 22.2°C) left over from before
  // this app took control. The old cron unknowingly fought it back every
  // night; the follow-the-human override logic would instead honour it as a
  // hand on the dial and hold 22.2°C all night. Kill it at the source.
  // POST /api/aiDebug?action=disable-schedules&email=…
  if (action === "disable-schedules") {
    const emailParam = request.nextUrl.searchParams.get("email");
    if (!emailParam) {
      return Response.json({ error: "email required" }, { status: 400 });
    }
    const user = await db.query.users.findFirst({
      where: eq(users.email, emailParam),
    });
    if (!user) return Response.json({ error: "no such user" }, { status: 404 });
    const token = await getFreshToken(user);
    const url = `${CLIENT_API_URL}/users/${user.eightUserId}/temperature`;
    const headers = {
      ...DEFAULT_API_HEADERS,
      authorization: `Bearer ${token.eightAccessToken}`,
      "content-type": "application/json",
    };
    const before = await fetch(url, { headers });
    const beforeBody = (await before.json()) as {
      settings?: { schedules?: { id: string; enabled: boolean }[] };
    };
    const schedules = beforeBody.settings?.schedules ?? [];
    const enabled = schedules.filter((s) => s.enabled);
    if (enabled.length === 0) {
      return Response.json({ alreadyClean: true, schedules });
    }
    const put = await fetch(url, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        schedules: schedules.map((s) => ({ ...s, enabled: false })),
      }),
    });
    const putBody = await put.text();
    // Verify by reading back — a 200 that silently kept the schedule armed
    // would be worse than a failure.
    const after = await fetch(url, { headers });
    const afterBody = (await after.json()) as {
      settings?: { schedules?: { id: string; enabled: boolean }[] };
      nextScheduledTimestamp?: string | null;
    };
    return Response.json({
      putStatus: put.status,
      putBody: putBody.slice(0, 300),
      schedulesBefore: schedules,
      schedulesAfter: afterBody.settings?.schedules ?? [],
      nextScheduledTimestamp: afterBody.nextScheduledTimestamp ?? null,
    });
  }

  // Re-score every held night on the CURRENT rubric. The only sanctioned way
  // past the score freeze: run it once after score.ts changes, for each user,
  // so history is comparable with itself again.
  // POST /api/aiDebug?action=rescore&email=…&pages=3   (≈10 nights per page)
  if (action === "rescore") {
    const email =
      request.nextUrl.searchParams.get("email") ?? "getnathan@outlook.com";
    const pages = Number(request.nextUrl.searchParams.get("pages") ?? "3");
    const user = await db.query.users.findFirst({ where: eq(users.email, email) });
    if (!user) return Response.json({ error: "user not found" }, { status: 404 });
    const profile = await db.query.userTemperatureProfile.findFirst({
      where: eq(userTemperatureProfile.email, email),
    });
    const timezone = profile?.timezoneTZ ?? "UTC";
    const token = await getFreshToken(user);
    const sessions = await fetchPodSessions(token, user.eightUserId, pages);
    const metrics = sessionsToMetrics(sessions, timezone);
    await persistNightMetrics(email, metrics, { rescore: true });
    return Response.json({
      email,
      rescored: metrics.map((m) => ({
        night: m.night,
        score: m.score,
        quality: m.thermalScore,
        asleepH:
          m.asleepHours == null ? null : Math.round(m.asleepHours * 100) / 100,
        awakeAfterOnsetH:
          m.awakeHours == null ? null : Math.round(m.awakeHours * 100) / 100,
        wakeCount: m.wakeCount,
      })),
    });
  }

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
