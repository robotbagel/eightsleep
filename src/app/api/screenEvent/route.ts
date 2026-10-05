import type { NextRequest } from "next/server";
import { desc, sql } from "drizzle-orm";
import { db } from "~/server/db";
import { appConfig, screenEvents } from "~/server/db/schema";

export const runtime = "nodejs";

// The bedroom screen watcher on the NAS (deploy/screen-watch) posts here.
//
//   POST /api/screenEvent   Authorization: Bearer CRON_SECRET
//   { "state": "on" | "off", "at": ISO, "app"?: string, "device"?: string,
//     "heartbeat"?: true }
//
// A change is stored only when it differs from the newest stored state, so a
// watcher that restarts and re-announces "off" adds nothing. Every call,
// change or heartbeat, records that the watcher is alive: /api/aiStatus
// reports it, and the monitor flags a watcher gone quiet, because a dead
// watcher would otherwise look exactly like a household that stopped
// watching TV.
export async function POST(request: NextRequest): Promise<Response> {
  if (request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  let body: {
    state?: unknown;
    at?: unknown;
    app?: unknown;
    device?: unknown;
    heartbeat?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "JSON body required" }, { status: 400 });
  }
  const state = body.state === "on" || body.state === "off" ? body.state : null;
  if (!state) {
    return Response.json({ error: 'state must be "on" or "off"' }, { status: 400 });
  }
  const parsed = typeof body.at === "string" ? new Date(body.at) : new Date();
  // A watcher clock far off is not trusted: the server's clock is used.
  const at =
    isNaN(parsed.getTime()) || Math.abs(parsed.getTime() - Date.now()) > 6 * 3_600_000
      ? new Date()
      : parsed;
  const app = typeof body.app === "string" ? body.app.slice(0, 80) : null;
  const device = typeof body.device === "string" ? body.device.slice(0, 80) : null;

  const now = new Date().toISOString();
  for (const [key, value] of [
    ["screen:lastSeenAt", now],
    ["screen:state", state],
  ] as const) {
    await db.execute(
      sql`insert into ${appConfig} ("key", "value") values (${key}, ${value})
          on conflict ("key") do update set "value" = excluded."value"`,
    );
  }

  // A heartbeat says the watcher is alive and what it currently sees; only
  // a change is history.
  if (body.heartbeat === true) {
    return Response.json({ stored: false, reason: "heartbeat", state });
  }

  const newest = await db
    .select({ state: screenEvents.state, at: screenEvents.at })
    .from(screenEvents)
    .orderBy(desc(screenEvents.at))
    .limit(1);
  if (newest[0]?.state === state) {
    return Response.json({ stored: false, reason: "unchanged", state });
  }
  // Changes arriving out of order (a retried post) must not rewrite history.
  if (newest[0] && newest[0].at > at) {
    return Response.json({ stored: false, reason: "older than the newest change", state });
  }
  await db.insert(screenEvents).values({ at, state, app, device });
  return Response.json({ stored: true, state, at: at.toISOString() });
}
