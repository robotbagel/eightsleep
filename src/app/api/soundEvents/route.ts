import type { NextRequest } from "next/server";
import { eq, inArray, lt } from "drizzle-orm";
import { db } from "~/server/db";
import { soundClips, soundEvents, userAiSettings } from "~/server/db/schema";

/** Clips are for judging recent nights, not an archive of the bedroom. */
const CLIP_DAYS = 14;
/** ~10 s of 32 kbit/s AAC is ~40 KB; anything far bigger is not a clip. */
const MAX_CLIP_B64 = 300_000;

export const runtime = "nodejs";

// Sleep Sync (ios/SleepSync) posts what it heard in the bedroom, every few
// minutes while it listens. Authenticated with the same per-user token as the
// Apple Health import, since it is the same app on the same phone.
//
//   POST /api/soundEvents   Authorization: Bearer <health import token>
//   { "device": "Nathan's iPhone",
//     "events": [{ "at": ISO, "kind": "cat_meow", "confidence": 0.82,
//                  "aboveQuietDb": 21, "durationS": 3 }, ...] }
//
// A retried batch must not double-count, so an event already stored with
// the same time and kind is skipped.
export async function POST(request: NextRequest): Promise<Response> {
  const token = (request.headers.get("authorization") ?? "")
    .replace(/^Bearer\s+/i, "")
    .trim();
  if (token.length < 20) return new Response("Unauthorized", { status: 401 });
  const owner = await db.query.userAiSettings.findFirst({
    where: eq(userAiSettings.healthImportToken, token),
  });
  if (!owner) return new Response("Unauthorized", { status: 401 });

  let body: { device?: unknown; events?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "JSON body required" }, { status: 400 });
  }
  if (!Array.isArray(body.events)) {
    return Response.json({ error: "events must be an array" }, { status: 400 });
  }
  const device = typeof body.device === "string" ? body.device.slice(0, 80) : null;
  const now = Date.now();
  const rows = body.events
    .slice(0, 2000)
    .map((raw) => {
      const e = raw as Record<string, unknown>;
      const at = typeof e.at === "string" ? new Date(e.at) : null;
      const kind = typeof e.kind === "string" ? e.kind.slice(0, 40) : null;
      if (!at || isNaN(at.getTime()) || !kind) return null;
      // Nothing from the future or older than two days.
      if (at.getTime() > now + 10 * 60_000 || at.getTime() < now - 2 * 86_400_000) return null;
      const num = (v: unknown) => (typeof v === "number" && isFinite(v) ? v : null);
      const confidence = num(e.confidence);
      const above = num(e.aboveQuietDb);
      const duration = num(e.durationS);
      const clip =
        typeof e.clip === "string" && e.clip.length <= MAX_CLIP_B64 ? e.clip : null;
      return {
        clip,
        at,
        kind,
        confidence: confidence == null ? null : Math.round(confidence * 100),
        aboveQuietDb: above == null ? null : Math.round(above),
        durationS: duration == null ? null : Math.round(duration),
        device,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r != null);
  if (rows.length === 0) return Response.json({ stored: 0 });

  const existing = await db
    .select({ at: soundEvents.at, kind: soundEvents.kind })
    .from(soundEvents)
    .where(
      inArray(
        soundEvents.at,
        rows.map((r) => r.at),
      ),
    );
  const seen = new Set(existing.map((e) => `${e.at.getTime()}|${e.kind}`));
  const fresh = rows.filter((r) => !seen.has(`${r.at.getTime()}|${r.kind}`));
  let clips = 0;
  if (fresh.length > 0) {
    const inserted = await db
      .insert(soundEvents)
      .values(fresh.map(({ clip: _clip, ...event }) => event))
      .returning({ id: soundEvents.id });
    const withClips = fresh
      .map((r, i) => ({ clip: r.clip, eventId: inserted[i]?.id }))
      .filter((c): c is { clip: string; eventId: number } => c.clip != null && c.eventId != null);
    if (withClips.length > 0) {
      await db.insert(soundClips).values(
        withClips.map((c) => ({ eventId: c.eventId, mime: "audio/mp4", dataB64: c.clip })),
      );
      clips = withClips.length;
    }
  }
  // Retention, done here because this is where clips arrive.
  await db
    .delete(soundClips)
    .where(lt(soundClips.createdAt, new Date(Date.now() - CLIP_DAYS * 86_400_000)));
  return Response.json({ stored: fresh.length, clips, skipped: rows.length - fresh.length });
}
