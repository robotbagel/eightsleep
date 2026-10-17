import assert from "node:assert";
import { TOKEN_TIME_BUFFER_SECONDS } from "../../eight/constants";
import {
  ensureFreshToken,
  renewToken,
  tokenNeedsRefresh,
  type TokenStoreDeps,
} from "../../eight/tokenStore";
import { type Token } from "../../eight/types";

const MIN = 60_000;
const now = Date.now();

const tok = (access: string, refresh: string, expiresAt: number): Token => ({
  eightAccessToken: access,
  eightRefreshToken: refresh,
  eightExpiresAtPosix: expiresAt,
  eightUserId: "u1",
});

// A fake store: one row, a refresh endpoint that rotates refresh tokens and
// rejects a refresh token that has already been spent (as OAuth servers do).
function fakeStore(initial: Token) {
  let row = { ...initial };
  let issued = 0;
  const spent = new Set<string>();
  const calls = { refresh: 0 };
  const deps: TokenStoreDeps = {
    readStored: async () => ({ ...row }),
    refresh: async (refreshToken) => {
      calls.refresh++;
      if (spent.has(refreshToken)) throw new Error("Invalid or expired refresh token");
      spent.add(refreshToken);
      issued++;
      return tok(`access-${issued}`, `refresh-${issued}`, Date.now() + 20 * 60 * MIN);
    },
    persist: async (t) => {
      row = { ...t };
    },
  };
  return { deps, calls, row: () => row, setRow: (t: Token) => (row = { ...t }) };
}

// --- THE OCTOBER 2026 401s ------------------------------------------------
// A tick started a few minutes before the stored expiry. The old check
// (`now > expiresAt`) said the token was fine, Eight Sleep refused it, and
// the whole tick failed. It must now be renewed ahead of the boundary.
assert.equal(tokenNeedsRefresh(now + 5 * MIN, now), true, "5 min left is inside the buffer");
assert.equal(tokenNeedsRefresh(now + TOKEN_TIME_BUFFER_SECONDS * 1000 + MIN, now), false);
assert.ok(TOKEN_TIME_BUFFER_SECONDS * 1000 > 10 * MIN, "buffer is longer than one cron interval");
console.log("ok  a token is renewed before a 10-minute tick can outlive it");

{
  const store = fakeStore(tok("old", "r0", now + 5 * MIN));
  const t = tok("old", "r0", now + 5 * MIN);
  const same = await ensureFreshToken(t, store.deps);
  assert.equal(same, t, "the caller's object is the one updated");
  assert.equal(t.eightAccessToken, "access-1");
  assert.equal(store.row().eightAccessToken, "access-1", "and the renewal is stored");
  console.log("ok  renewal updates the caller's token in place and persists it");
}

{
  const store = fakeStore(tok("old", "r0", now + 60 * MIN));
  const t = tok("old", "r0", now + 60 * MIN);
  await ensureFreshToken(t, store.deps);
  assert.equal(store.calls.refresh, 0, "a token with an hour left is left alone");
  console.log("ok  a healthy token is not renewed");
}

// A rejected token is renewed even though its stored expiry is far off.
{
  const store = fakeStore(tok("old", "r0", now + 60 * MIN));
  const t = tok("old", "r0", now + 60 * MIN);
  await renewToken(t, store.deps);
  assert.equal(t.eightAccessToken, "access-1");
  console.log("ok  a token the API refused is renewed whatever its expiry says");
}

// Another invocation (the other scheduler, the app) renewed first. We must
// adopt its token, not spend our now-rotated refresh token.
{
  const store = fakeStore(tok("old", "r0", now + 2 * MIN));
  store.setRow(tok("theirs", "r-theirs", now + 20 * 60 * MIN));
  const t = tok("old", "r0", now + 2 * MIN);
  await renewToken(t, store.deps);
  assert.equal(t.eightAccessToken, "theirs");
  assert.equal(store.calls.refresh, 0, "no refresh token spent");
  console.log("ok  a renewal stored by someone else is adopted");
}

// Lost the race between our read and our refresh: the refresh fails because
// the token was rotated away, and the winner's token is in the store.
{
  const store = fakeStore(tok("old", "r0", now + 2 * MIN));
  const realRefresh = store.deps.refresh;
  store.deps.refresh = async () => {
    store.setRow(tok("winner", "r-w", now + 20 * 60 * MIN));
    throw new Error("Invalid or expired refresh token");
  };
  const t = tok("old", "r0", now + 2 * MIN);
  await renewToken(t, store.deps);
  assert.equal(t.eightAccessToken, "winner");
  store.deps.refresh = realRefresh;
  console.log("ok  losing a renewal race falls back to the winner's token");
}

// Two callers with the same expiring token in one invocation share one refresh.
{
  const store = fakeStore(tok("old", "r0", now + 2 * MIN));
  const a = tok("old", "r0", now + 2 * MIN);
  const b = tok("old", "r0", now + 2 * MIN);
  await Promise.all([ensureFreshToken(a, store.deps), ensureFreshToken(b, store.deps)]);
  assert.equal(store.calls.refresh, 1);
  assert.equal(a.eightAccessToken, b.eightAccessToken);
  console.log("ok  concurrent renewals in one invocation spend one refresh token");
}

// A genuinely dead refresh token still surfaces as an error.
{
  const store = fakeStore(tok("old", "r0", now + 2 * MIN));
  store.deps.refresh = async () => {
    throw new Error("Invalid or expired refresh token");
  };
  await assert.rejects(renewToken(tok("old", "r0", now + 2 * MIN), store.deps), /refresh token/);
  console.log("ok  a dead refresh token is reported, not hidden");
}
