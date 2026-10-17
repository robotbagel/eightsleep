// tokenStore.ts
//
// ONE place that decides when an Eight Sleep access token is renewed, so the
// cron, the AI passes and the app cannot each hold their own idea of it.
//
// Two failure modes this exists for (both seen in production, Oct 2026: a
// single 10-minute tick failing with "API request failed: 401" every few
// days, always ~5 s in, i.e. the very first call of the tick was rejected
// while our stored expiry still said the token was good):
//   1. Renewing only AFTER the stored expiry leaves no room for Eight Sleep
//      expiring it a little sooner, or for a tick that starts just before the
//      boundary and is still running after it. Tokens are now renewed
//      TOKEN_TIME_BUFFER_SECONDS early.
//   2. A token the API rejects anyway (revoked, rotated by a concurrent
//      renewal in another invocation) was never retried. fetchWithAuth now
//      calls recoverRejectedToken() once on a 401 and repeats the request.
import { eq } from "drizzle-orm";
import { db } from "~/server/db";
import { users } from "~/server/db/schema";
import { obtainFreshAccessToken } from "./auth";
import { TOKEN_TIME_BUFFER_SECONDS } from "./constants";
import { type Token } from "./types";

export function tokenNeedsRefresh(expiresAtPosix: number, now = Date.now()): boolean {
  return now > expiresAtPosix - TOKEN_TIME_BUFFER_SECONDS * 1000;
}

export interface TokenStoreDeps {
  readStored: (eightUserId: string) => Promise<Token | null>;
  refresh: (refreshToken: string, eightUserId: string) => Promise<Token>;
  persist: (token: Token) => Promise<void>;
}

const dbDeps: TokenStoreDeps = {
  async readStored(eightUserId) {
    const row = await db.query.users.findFirst({
      where: eq(users.eightUserId, eightUserId),
    });
    if (!row) return null;
    return {
      eightAccessToken: row.eightAccessToken,
      eightRefreshToken: row.eightRefreshToken,
      eightExpiresAtPosix: row.eightTokenExpiresAt.getTime(),
      eightUserId: row.eightUserId,
    };
  },
  refresh: obtainFreshAccessToken,
  async persist(token) {
    await db
      .update(users)
      .set({
        eightAccessToken: token.eightAccessToken,
        eightRefreshToken: token.eightRefreshToken,
        eightTokenExpiresAt: new Date(token.eightExpiresAtPosix),
        updatedAt: new Date(),
      })
      .where(eq(users.eightUserId, token.eightUserId));
  },
};

// Renewals already in flight in this invocation, so two callers holding the
// same expired token spend ONE refresh token between them.
const inFlight = new Map<string, Promise<Token>>();

/**
 * Replace `token`'s contents with a usable token. The object is updated IN
 * PLACE: a cron tick builds one token and hands it to a dozen calls, and every
 * later call must see the renewed one.
 *
 * Renews whatever `token`'s own expiry says: callers come here either because
 * it is about to expire or because the API has just refused it.
 */
export async function renewToken(token: Token, deps: TokenStoreDeps = dbDeps): Promise<Token> {
  const usedAccessToken = token.eightAccessToken;
  const key = `${token.eightUserId}:${usedAccessToken}`;

  let pending = inFlight.get(key);
  if (!pending) {
    pending = (async () => {
      // Another invocation may already have renewed it (the NAS and Mac
      // schedulers, the app and the AI passes all run separately). Its
      // result is in the database; spending our refresh token again could
      // invalidate the one it just stored.
      const stored = await deps.readStored(token.eightUserId);
      if (
        stored &&
        stored.eightAccessToken !== usedAccessToken &&
        !tokenNeedsRefresh(stored.eightExpiresAtPosix)
      ) {
        return stored;
      }

      const refreshToken = stored?.eightRefreshToken ?? token.eightRefreshToken;
      try {
        const fresh = await deps.refresh(refreshToken, token.eightUserId);
        await deps.persist(fresh);
        return fresh;
      } catch (error) {
        // Lost a race: someone renewed between our read and our refresh,
        // and the refresh token we used was rotated away. Theirs is stored.
        const after = await deps.readStored(token.eightUserId);
        if (after && after.eightAccessToken !== usedAccessToken) return after;
        throw error;
      }
    })().finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
  }

  const fresh = await pending;
  Object.assign(token, fresh);
  return token;
}

/** Renew `token` when it is within the buffer of expiring; otherwise leave it. */
export async function ensureFreshToken(token: Token, deps: TokenStoreDeps = dbDeps): Promise<Token> {
  if (!tokenNeedsRefresh(token.eightExpiresAtPosix)) return token;
  return renewToken(token, deps);
}

/** Called by fetchWithAuth after a 401. */
export async function recoverRejectedToken(token: Token): Promise<Token> {
  return renewToken(token);
}
