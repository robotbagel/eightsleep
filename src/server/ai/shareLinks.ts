// shareLinks.ts
// Letting somebody who is not the account holder control one side of the bed.
//
// Everything else in this app assumes one login, one Eight Sleep account, one
// side. That is right for the owner and wrong for the two people who actually
// need to touch the controls and have no way to: a guest sleeping over, and a
// partner who has her own side but was never going to type Eight Sleep
// credentials into a self-hosted app to reach it.
//
// WHY A DATABASE ROW AND NOT A SIGNED TOKEN. A JWT in a URL cannot be taken
// back. This link opens a heating device in somebody's bedroom, and links
// travel — forwarded messages, screenshots, a phone that gets handed round.
// So the URL carries an opaque random secret, only its HASH is stored, and
// every request looks the row up: revoking is immediate, an issued link can
// be listed and labelled, and the stored side is useless to anyone who reads
// the database.
//
// WHAT EACH ROLE MAY DO is deliberately narrow and lives in CAPABILITIES
// below, so a future endpoint cannot quietly inherit guest access by
// forgetting to check.

import { createHash, randomBytes } from "crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "~/server/db";
import { shareLinks } from "~/server/db/schema";

export const SHARE_ROLES = ["guest", "household"] as const;
export type ShareRole = (typeof SHARE_ROLES)[number];

export interface Capabilities {
  /** Change the bed temperature now, for tonight. */
  setTemperature: boolean;
  /** Say how the bed feels, which steers the loop. */
  giveComfortFeedback: boolean;
  /** Change the stored schedule: bedtime, wake-up, the four stage levels. */
  editSchedule: boolean;
  /** See the sleep history and the AI's reasoning. */
  seeHistory: boolean;
  /** Change autopilot settings, or issue further links. */
  administer: boolean;
  /**
   * Do this person's nights teach the owner's temperature loop? False for a
   * guest: their deep sleep is not a verdict on the owner's profile, and a
   * nudge fired for their comfort must not fold into the owner's baseline.
   */
  nightsAreTheOwners: boolean;
}

export const CAPABILITIES: Record<ShareRole, Capabilities> = {
  guest: {
    setTemperature: true,
    giveComfortFeedback: true,
    editSchedule: false,
    seeHistory: false,
    administer: false,
    nightsAreTheOwners: false,
  },
  household: {
    setTemperature: true,
    giveComfortFeedback: true,
    editSchedule: true,
    seeHistory: true,
    administer: false,
    nightsAreTheOwners: true,
  },
};

/** How long a guest link lasts unless the owner picks otherwise. */
export const GUEST_LINK_DEFAULT_DAYS = 2;
export const GUEST_LINK_MAX_DAYS = 30;

/**
 * 32 random bytes, URL-safe. Long enough that guessing is not a threat model,
 * short enough to survive being pasted into a message.
 */
function mintSecret(): string {
  return randomBytes(24).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface IssuedLink {
  /** The secret. Returned ONCE, at creation; never readable again. */
  token: string;
  id: number;
  role: ShareRole;
  label: string | null;
  expiresAt: Date | null;
}

export async function createShareLink(input: {
  email: string;
  role: ShareRole;
  label: string | null;
  days: number | null;
}): Promise<IssuedLink> {
  const token = mintSecret();
  // A household link is for someone who lives there; it does not lapse. A
  // guest link always does, because the commonest way one of these leaks is
  // simply outliving the visit everyone has forgotten about.
  const days =
    input.role === "household"
      ? null
      : Math.min(input.days ?? GUEST_LINK_DEFAULT_DAYS, GUEST_LINK_MAX_DAYS);
  const expiresAt =
    days == null ? null : new Date(Date.now() + days * 86_400_000);

  const [row] = await db
    .insert(shareLinks)
    .values({
      email: input.email,
      tokenHash: hashToken(token),
      role: input.role,
      label: input.label,
      expiresAt,
    })
    .returning({ id: shareLinks.id });

  return { token, id: row!.id, role: input.role, label: input.label, expiresAt };
}

export interface ShareSession {
  email: string;
  role: ShareRole;
  label: string | null;
  capabilities: Capabilities;
  expiresAt: Date | null;
}

/**
 * Resolve a link secret to the side it controls and what it may do. Returns
 * null for anything not currently valid — unknown, revoked or expired — with
 * no hint as to which, because the holder of a bad token is owed no detail.
 */
export async function resolveShareLink(
  token: string | null | undefined,
): Promise<ShareSession | null> {
  if (!token || token.length < 16) return null;
  const row = await db.query.shareLinks.findFirst({
    where: and(
      eq(shareLinks.tokenHash, hashToken(token)),
      isNull(shareLinks.revokedAt),
    ),
  });
  if (!row) return null;
  if (row.expiresAt != null && row.expiresAt.getTime() < Date.now()) return null;
  const role = (SHARE_ROLES as readonly string[]).includes(row.role)
    ? (row.role as ShareRole)
    : null;
  if (role == null) return null;

  // Best-effort: knowing a link is in use matters more than the write.
  void db
    .update(shareLinks)
    .set({ lastUsedAt: new Date() })
    .where(eq(shareLinks.id, row.id))
    .execute()
    .catch(() => undefined);

  return {
    email: row.email,
    role,
    label: row.label,
    capabilities: CAPABILITIES[role],
    expiresAt: row.expiresAt,
  };
}

export async function revokeShareLink(
  email: string,
  id: number,
): Promise<void> {
  await db
    .update(shareLinks)
    .set({ revokedAt: new Date() })
    .where(and(eq(shareLinks.id, id), eq(shareLinks.email, email)));
}

export interface ListedLink {
  id: number;
  role: ShareRole;
  label: string | null;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
  active: boolean;
}

export async function listShareLinks(email: string): Promise<ListedLink[]> {
  const rows = await db.query.shareLinks.findMany({
    where: and(eq(shareLinks.email, email), isNull(shareLinks.revokedAt)),
  });
  const now = Date.now();
  return rows
    .map((row) => ({
      id: row.id,
      role: row.role as ShareRole,
      label: row.label,
      expiresAt: row.expiresAt,
      lastUsedAt: row.lastUsedAt,
      createdAt: row.createdAt,
      active: row.expiresAt == null || row.expiresAt.getTime() > now,
    }))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

/** Plain-English summary of what a link's holder can do, for the owner. */
export function describeRole(role: ShareRole): string {
  return role === "guest"
    ? "Can set the bed temperature and say how it feels, for as long as the link lasts. Cannot see your sleep history or change your schedule, and their nights never affect your settings."
    : "Can control their own side completely: temperature, schedule and their own sleep history. Cannot change your side or issue links.";
}
