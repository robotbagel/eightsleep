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
import { and, desc, eq, gt, isNull, or } from "drizzle-orm";
import { db } from "~/server/db";
import { guestProfiles, shareLinks } from "~/server/db/schema";

export const SHARE_ROLES = ["guest", "household"] as const;
export type ShareRole = (typeof SHARE_ROLES)[number];

export interface Capabilities {
  /** Change the bed temperature now, for tonight. */
  setTemperature: boolean;
  /** Say how the bed feels, which steers the loop. */
  giveComfortFeedback: boolean;
  /**
   * Set all four stages and the times for the length of the stay, WITHOUT
   * touching the owner's stored profile — see `guestProfiles`. A visitor
   * arrives in the afternoon to a bed that is off, so two live buttons are
   * no use to them; they need to set up the night ahead.
   */
  setStayProfile: boolean;
  /** Write the account's OWN stored schedule. Their side, their row. */
  editOwnerSchedule: boolean;
  /**
   * Read back the nights THIS LINK slept — never the owner's. A guest sees
   * exactly what the owner sees about a night, for their own nights only:
   * the point of lending someone the bed is that they find out what it
   * knows about them.
   */
  seeOwnNights: boolean;
  /** Read the account holder's whole history and the AI's reasoning. */
  seeOwnerHistory: boolean;
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
    setStayProfile: true,
    editOwnerSchedule: false,
    seeOwnNights: true,
    seeOwnerHistory: false,
    administer: false,
    nightsAreTheOwners: false,
  },
  household: {
    setTemperature: true,
    giveComfortFeedback: true,
    // Their own side, so their schedule IS the stored one.
    setStayProfile: false,
    editOwnerSchedule: true,
    seeOwnNights: true,
    seeOwnerHistory: true,
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
  id: number;
  email: string;
  role: ShareRole;
  label: string | null;
  capabilities: Capabilities;
  expiresAt: Date | null;
  /** When the link was issued — the earliest night it may ever read. */
  createdAt: Date;
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
    id: row.id,
    email: row.email,
    role,
    label: row.label,
    capabilities: CAPABILITIES[role],
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
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
    ? "Can set up their own night — all four stages — and read their own sleep afterwards, for as long as the link lasts. Cannot see your nights or change your schedule, and their nights never affect your settings."
    : "Can control their own side completely: temperature, schedule and their own sleep history. Cannot change your side or issue links.";
}

// ---------------------------------------------------------------------------
// The guest's own schedule, overlaid on the owner's
// ---------------------------------------------------------------------------


export interface StageLevels {
  bedTime: string;
  wakeupTime: string;
  initialSleepLevel: number;
  deepSleepLevel: number;
  midStageSleepLevel: number;
  finalSleepLevel: number;
}

/**
 * The guest schedule currently in force for a side, or null.
 *
 * "In force" means a guest saved one AND their link is still valid. That is
 * the whole expiry mechanism: nothing has to clean up after a visit, because
 * the overlay stops applying the moment the link lapses or is withdrawn, and
 * the owner's untouched profile is simply used again.
 */
export async function activeGuestProfile(
  email: string,
): Promise<StageLevels | null> {
  const now = new Date();
  const rows = await db
    .select({
      bedTime: guestProfiles.bedTime,
      wakeupTime: guestProfiles.wakeupTime,
      initialSleepLevel: guestProfiles.initialSleepLevel,
      deepSleepLevel: guestProfiles.deepSleepLevel,
      midStageSleepLevel: guestProfiles.midStageSleepLevel,
      finalSleepLevel: guestProfiles.finalSleepLevel,
      updatedAt: guestProfiles.updatedAt,
    })
    .from(guestProfiles)
    .innerJoin(shareLinks, eq(guestProfiles.shareLinkId, shareLinks.id))
    .where(
      and(
        eq(guestProfiles.email, email),
        isNull(shareLinks.revokedAt),
        or(isNull(shareLinks.expiresAt), gt(shareLinks.expiresAt, now)),
      ),
    )
    .orderBy(desc(guestProfiles.updatedAt))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  return {
    bedTime: row.bedTime,
    wakeupTime: row.wakeupTime,
    initialSleepLevel: row.initialSleepLevel,
    deepSleepLevel: row.deepSleepLevel,
    midStageSleepLevel: row.midStageSleepLevel,
    finalSleepLevel: row.finalSleepLevel,
  };
}

/** Save (or replace) the schedule belonging to one guest link. */
export async function saveGuestProfile(
  shareLinkId: number,
  email: string,
  levels: StageLevels,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(guestProfiles).where(eq(guestProfiles.shareLinkId, shareLinkId));
    await tx.insert(guestProfiles).values({
      shareLinkId,
      email,
      bedTime: levels.bedTime,
      wakeupTime: levels.wakeupTime,
      initialSleepLevel: levels.initialSleepLevel,
      deepSleepLevel: levels.deepSleepLevel,
      midStageSleepLevel: levels.midStageSleepLevel,
      finalSleepLevel: levels.finalSleepLevel,
    });
  });
}

export async function guestProfileFor(
  shareLinkId: number,
): Promise<StageLevels | null> {
  const row = await db.query.guestProfiles.findFirst({
    where: eq(guestProfiles.shareLinkId, shareLinkId),
  });
  return row
    ? {
        bedTime: row.bedTime,
        wakeupTime: row.wakeupTime,
        initialSleepLevel: row.initialSleepLevel,
        deepSleepLevel: row.deepSleepLevel,
        midStageSleepLevel: row.midStageSleepLevel,
        finalSleepLevel: row.finalSleepLevel,
      }
    : null;
}
