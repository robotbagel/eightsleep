import type { NextRequest } from "next/server";
import jwt from "jsonwebtoken";
import { eq } from "drizzle-orm";
import { db } from "~/server/db";
import { soundClips, users } from "~/server/db/schema";

export const runtime = "nodejs";

// Plays one night-sound clip: GET /api/soundClip/<eventId>.
// Bedroom audio, so only a signed-in owner of this bed may hear it: the same
// session cookie the app uses, checked against a real account. A share-link
// guest has no such cookie and gets nothing.
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } },
): Promise<Response> {
  // The operator's key also works, so playback can be checked without
  // anyone's Eight Sleep login.
  const operator =
    request.headers.get("authorization") === `Bearer ${process.env.CRON_SECRET}`;
  if (!operator) {
    const token = request.cookies.get("8slpAutht")?.value;
    if (!token) return new Response("Unauthorized", { status: 401 });
    let email: string;
    try {
      email = (jwt.verify(token, process.env.JWT_SECRET!) as { email: string }).email;
    } catch {
      return new Response("Unauthorized", { status: 401 });
    }
    const owner = await db.query.users.findFirst({ where: eq(users.email, email) });
    if (!owner) return new Response("Unauthorized", { status: 401 });
  }

  const eventId = Number(params.id);
  if (!Number.isInteger(eventId)) return new Response("Not found", { status: 404 });
  const clip = await db.query.soundClips.findFirst({
    where: eq(soundClips.eventId, eventId),
  });
  if (!clip) return new Response("Not found", { status: 404 });
  const bytes = Buffer.from(clip.dataB64, "base64");
  // Safari on iPhone only plays media from a server that honours byte
  // ranges: it asks for bytes=0-1 first and gives up on a plain 200.
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range") ?? "");
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = Math.min(range[2] ? Number(range[2]) : bytes.length - 1, bytes.length - 1);
    if (start > end || start >= bytes.length) {
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${bytes.length}` },
      });
    }
    const part = bytes.subarray(start, end + 1);
    return new Response(part, {
      status: 206,
      headers: {
        "Content-Type": clip.mime,
        "Content-Length": String(part.length),
        "Content-Range": `bytes ${start}-${end}/${bytes.length}`,
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, max-age=86400",
      },
    });
  }
  return new Response(bytes, {
    headers: {
      "Content-Type": clip.mime,
      "Content-Length": String(bytes.length),
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=86400",
    },
  });
}
