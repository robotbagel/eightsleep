// healthImport: receives last night's Apple Health sleep data from an iPhone
// Shortcut. Authenticated by a per-user bearer token (shown in the app's AI
// card). Storing a night immediately triggers the daily AI assessment if it
// hasn't happened yet.
import type { NextRequest } from "next/server";
import { db } from "~/server/db";
import { userAiSettings, userTemperatureProfile } from "~/server/db/schema";
import { eq } from "drizzle-orm";
import { HealthImportSchema, storeHealthImport } from "~/server/ai/health";
import { triggerAssessmentAfterImport } from "~/server/ai/advisor";
import { appConfig } from "~/server/db/schema";

export const runtime = "nodejs";

export async function POST(request: NextRequest): Promise<Response> {
  // Token accepted either as a bearer header or a ?token= query param, so the
  // iPhone Shortcut needs no custom header (fewer setup steps, fewer errors).
  const authHeader = request.headers.get("authorization") ?? "";
  const token =
    authHeader.replace(/^Bearer\s+/i, "").trim() ||
    (request.nextUrl.searchParams.get("token") ?? "").trim();
  if (token.length < 20) {
    return new Response("Unauthorized", { status: 401 });
  }
  const settings = await db.query.userAiSettings.findFirst({
    where: eq(userAiSettings.healthImportToken, token),
  });
  if (!settings) {
    return new Response("Unauthorized", { status: 401 });
  }

  let payload;
  let rawSamples = "";
  try {
    const contentType = request.headers.get("content-type") ?? "";
    if (contentType.includes("json")) {
      payload = HealthImportSchema.parse(await request.json());
      rawSamples = payload.samples ?? "";
    } else {
      // Raw text body = sample lines straight from the Shortcut.
      rawSamples = await request.text();
      payload = HealthImportSchema.parse({ samples: rawSamples });
    }
  } catch (error) {
    return Response.json(
      {
        error: `Invalid payload: ${error instanceof Error ? error.message : String(error)}`,
      },
      { status: 400 },
    );
  }

  const profile = await db.query.userTemperatureProfile.findFirst({
    where: eq(userTemperatureProfile.email, settings.email),
  });
  const timezone = profile?.timezoneTZ ?? "UTC";

  // Debug: keep the last raw payload (the user's own data, on their own
  // server) so parsing can be diagnosed. Truncated; overwritten each import.
  try {
    await db
      .insert(appConfig)
      .values({
        key: `lastRaw:${settings.email}`,
        value: rawSamples.slice(0, 12000),
      })
      .onConflictDoUpdate({
        target: appConfig.key,
        set: { value: rawSamples.slice(0, 12000) },
      })
      .execute();
  } catch {
    // debug capture is best-effort
  }

  try {
    const stored = await storeHealthImport(settings.email, payload, timezone);
    // Assessment failures (e.g. missing Gemini key) must not fail the import.
    try {
      await triggerAssessmentAfterImport(settings.email);
    } catch (error) {
      console.error(
        `Assessment after import failed for ${settings.email}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
    return Response.json({ success: true, ...stored });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
