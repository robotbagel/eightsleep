// soundStats.ts
// "Is that more than coincidence?" for a handful of wake-ups.
//
// A night has only a few wake-ups, so a rule like "a quarter of them followed
// a sound" is either too eager (two coincidences on a noisy night) or blind
// (one meow before one of three wake-ups, every night for a week). The honest
// test is how unlikely the count is by chance: if sounds sit in the two
// minutes before 3% of the night's minutes, one of three wake-ups landing
// there happens by chance 9% of the time, two of three only 0.3%. And across
// nights the same small coincidences add up, so the verdict is pooled.

/** P(X >= k) for X ~ Binomial(n, p). */
export function binomialTail(k: number, n: number, p: number): number {
  if (k <= 0) return 1;
  if (k > n) return 0;
  const q = Math.min(Math.max(p, 1e-6), 1 - 1e-6);
  let total = 0;
  let coeff = 1; // C(n, 0)
  for (let x = 0; x <= n; x++) {
    if (x > 0) coeff = (coeff * (n - x + 1)) / x;
    if (x >= k) total += coeff * q ** x * (1 - q) ** (n - x);
  }
  return Math.min(1, total);
}

/** Below this, the count is called more than coincidence. */
export const SIGNIFICANT = 0.05;

export interface SoundTally {
  wakeUps: number;
  afterSound: number;
  /** Share of the night's minutes that had a sound just before them. */
  chanceShare: number;
}

export interface SoundVerdict {
  nights: number;
  wakeUps: number;
  afterSound: number;
  /** How many of the wake-ups chance alone would put after a sound. */
  expected: number;
  pValue: number;
  likelyCause: boolean;
}

/** Pools several nights: wake-ups add up, chance is weighted by wake-ups. */
export function soundVerdict(nights: SoundTally[]): SoundVerdict {
  const wakeUps = nights.reduce((s, n) => s + n.wakeUps, 0);
  const afterSound = nights.reduce((s, n) => s + n.afterSound, 0);
  const expected = nights.reduce((s, n) => s + n.wakeUps * n.chanceShare, 0);
  const p = wakeUps > 0 ? expected / wakeUps : 0;
  const pValue = binomialTail(afterSound, wakeUps, p);
  return {
    nights: nights.length,
    wakeUps,
    afterSound,
    expected: Math.round(expected * 10) / 10,
    pValue,
    likelyCause: afterSound >= 1 && pValue < SIGNIFICANT,
  };
}
