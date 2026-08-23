// push.ts
// Web Push for the morning sleep report. The VAPID keypair is generated once
// and stored in the appConfig table, so no manual env configuration is
// needed. Subscriptions are per account; dead subscriptions (410/404) are
// pruned automatically on send.
import webpush from "web-push";
import { db } from "~/server/db";
import { appConfig, pushSubscriptions } from "~/server/db/schema";
import { eq } from "drizzle-orm";

const VAPID_KEY = "vapidKeys";

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

let cachedKeys: VapidKeys | null = null;

export async function getVapidKeys(): Promise<VapidKeys> {
  if (cachedKeys) return cachedKeys;
  const row = await db.query.appConfig.findFirst({
    where: eq(appConfig.key, VAPID_KEY),
  });
  if (row) {
    cachedKeys = JSON.parse(row.value) as VapidKeys;
    return cachedKeys;
  }
  const generated = webpush.generateVAPIDKeys();
  const keys: VapidKeys = {
    publicKey: generated.publicKey,
    privateKey: generated.privateKey,
  };
  // Guard against a concurrent first-time generation: if another request won
  // the race, use its keys instead of overwriting them.
  await db
    .insert(appConfig)
    .values({ key: VAPID_KEY, value: JSON.stringify(keys) })
    .onConflictDoNothing()
    .execute();
  const winner = await db.query.appConfig.findFirst({
    where: eq(appConfig.key, VAPID_KEY),
  });
  cachedKeys = winner ? (JSON.parse(winner.value) as VapidKeys) : keys;
  return cachedKeys;
}

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
}

export async function sendPushToUser(
  email: string,
  payload: PushPayload,
): Promise<void> {
  const subscriptions = await db
    .select()
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.email, email));
  if (subscriptions.length === 0) return;

  const keys = await getVapidKeys();
  webpush.setVapidDetails(
    "mailto:admin@example.com",
    keys.publicKey,
    keys.privateKey,
  );

  for (const subscription of subscriptions) {
    try {
      await webpush.sendNotification(
        {
          endpoint: subscription.endpoint,
          keys: { p256dh: subscription.p256dh, auth: subscription.auth },
        },
        JSON.stringify(payload),
        { TTL: 12 * 60 * 60, urgency: "normal" },
      );
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode;
      if (statusCode === 404 || statusCode === 410) {
        await db
          .delete(pushSubscriptions)
          .where(eq(pushSubscriptions.id, subscription.id));
        console.log(`Pruned dead push subscription ${subscription.id} for ${email}`);
      } else {
        console.error(
          `Push send failed for ${email}:`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }
}
