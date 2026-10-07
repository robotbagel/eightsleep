// sound.ts
// "Did a sound wake us, or was it the bed?"
//
// Sleep Sync (ios/SleepSync) listens in the bedroom at night with Apple's
// on-device sound classifier and a level meter, and posts what it hears: a
// cat meowing or purring, a thud, a door, snoring, speech, or anything well
// above the room's quiet. No audio is kept or sent, only the time, the kind
// of sound, how sure the classifier was and how loud it was.
//
// Here the sounds are laid over the pod's own record of the night. A wake-up
// or a toss that follows a sound within a couple of minutes was probably
// caused by it, and that matters twice: the sleeper learns what is waking
// them, and the temperature loop must not read a cat as a bed that is too
// warm. The comparison against chance keeps that honest: if a sound is
// within two minutes of half of all moments anyway, sounds "before wake-ups"
// prove nothing.
//
// The bedroom is shared, so sounds are household-wide like the screen.

import { and, asc, gte, lte } from "drizzle-orm";
import { db } from "~/server/db";
import { soundEvents } from "~/server/db/schema";
import { soundVerdict } from "~/lib/soundStats";
import { screenEventsBetween } from "./screen";

export interface SoundEvent {
  /** Row id, for fetching its clip; absent in tests. */
  id?: number;
  at: Date;
  kind: string;
  /** Loudness above the room's quiet, dB; null when not measured. */
  aboveQuietDb: number | null;
}

export interface SoundNight {
  /** Count per kind of sound heard while asleep. */
  counts: Record<string, number>;
  wakeUps: number;
  /** Wake-ups with a sound in the two minutes before, and which sound. */
  wakeUpsAfterSound: { at: string; kind: string }[];
  tosses: number;
  tossesAfterSound: number;
  /**
   * Share of the night's minutes that had a sound in the two minutes before
   * them. Wake-ups following sounds only mean something when their share is
   * well above this.
   */
  chanceShare: number;
  /** How likely this many wake-ups follow a sound by chance alone. */
  pValue?: number;
  /** Too many wake-ups followed a sound to be coincidence (soundStats.ts). */
  likelyCause: boolean;
}

/** A sound this long before a wake-up or toss is a candidate cause. */
export const SOUND_LEAD_MS = 2 * 60_000;
/** ...and a wake-up can be logged a little ahead of the sound's timestamp. */
const SOUND_LAG_MS = 15_000;

/** The sound, if any, that came just before `t` (newest first wins). */
export function soundBefore(events: SoundEvent[], t: number): SoundEvent | null {
  let found: SoundEvent | null = null;
  for (const event of events) {
    const at = event.at.getTime();
    if (at <= t + SOUND_LAG_MS && at >= t - SOUND_LEAD_MS) {
      if (!found || at > found.at.getTime()) found = event;
    }
  }
  return found;
}

/**
 * Lays sounds over one night. Pure. `wakeUps` and `tosses` are timestamps
 * (ms) from the pod; `events` may extend beyond the night.
 */
export function soundNight(
  events: SoundEvent[],
  sleepStart: number,
  sleepEnd: number,
  wakeUps: number[],
  tosses: number[],
): SoundNight | null {
  const night = events.filter((e) => {
    const t = e.at.getTime();
    return t >= sleepStart - SOUND_LEAD_MS && t <= sleepEnd;
  });
  if (night.length === 0) return null;

  const counts: Record<string, number> = {};
  for (const e of night) counts[e.kind] = (counts[e.kind] ?? 0) + 1;

  const wakeUpsAfterSound = wakeUps
    .map((t) => ({ t, sound: soundBefore(night, t) }))
    .filter((w): w is { t: number; sound: SoundEvent } => w.sound != null)
    .map((w) => ({ at: new Date(w.t).toISOString(), kind: w.sound.kind }));
  const tossesAfterSound = tosses.filter((t) => soundBefore(night, t) != null).length;

  // How much of the night was "just after a sound" anyway, sampled per minute.
  let covered = 0;
  let minutes = 0;
  for (let t = sleepStart; t <= sleepEnd; t += 60_000) {
    minutes += 1;
    if (soundBefore(night, t) != null) covered += 1;
  }
  const chanceShare = minutes > 0 ? covered / minutes : 0;
  const verdict = soundVerdict([
    { wakeUps: wakeUps.length, afterSound: wakeUpsAfterSound.length, chanceShare },
  ]);

  return {
    counts,
    wakeUps: wakeUps.length,
    wakeUpsAfterSound,
    tosses: tosses.length,
    tossesAfterSound,
    chanceShare: Math.round(chanceShare * 100) / 100,
    pValue: Math.round(verdict.pValue * 1000) / 1000,
    likelyCause: verdict.likelyCause,
  };
}

/** Wake-up times inside the sleep window, merged like wakeEventCount(). */
export function wakeUpTimes(
  markers: [string, number][] | null | undefined,
  sleepStart: number,
  sleepEnd: number,
): number[] {
  const out: number[] = [];
  let last: number | null = null;
  for (const [ts] of markers ?? []) {
    const at = Date.parse(ts);
    if (isNaN(at) || at < sleepStart || at > sleepEnd) continue;
    if (last == null || at - last > 10 * 60_000) out.push(at);
    last = at;
  }
  return out;
}

/** Sounds in a window, oldest first. Never throws: no data = no sounds. */
export async function soundEventsBetween(from: Date, to: Date): Promise<SoundEvent[]> {
  try {
    const rows = await db
      .select({
        id: soundEvents.id,
        at: soundEvents.at,
        kind: soundEvents.kind,
        aboveQuietDb: soundEvents.aboveQuietDb,
      })
      .from(soundEvents)
      .where(and(gte(soundEvents.at, from), lte(soundEvents.at, to)))
      .orderBy(asc(soundEvents.at));
    return rows;
  } catch (error) {
    console.error(
      "Sound events unreadable, ignoring them:",
      error instanceof Error ? error.message : String(error),
    );
    return [];
  }
}

interface SessionForSound {
  ts?: string | null;
  sleepStart?: string | null;
  sleepEnd?: string | null;
  presenceEnd?: string | null;
  timeseries?: {
    shortAwakes?: [string, number][] | null;
    tnt?: [string, number][] | null;
  } | null;
  sound?: SoundNight | null;
  soundEvents?: SoundEvent[];
}

/**
 * Attach each session's sound summary, in place, from ONE read. Also keeps
 * the raw events on the session, so the live tuner can discount a toss that
 * followed a sound.
 */
export async function attachSounds<T extends SessionForSound>(sessions: T[]): Promise<void> {
  const spans = sessions
    .map((s) => ({
      s,
      start: s.sleepStart ? Date.parse(s.sleepStart) : NaN,
      end: s.sleepEnd ? Date.parse(s.sleepEnd) : NaN,
    }))
    .filter((x) => !isNaN(x.start) && !isNaN(x.end));
  if (spans.length === 0) return;
  // The chart shows everything heard while someone was in bed (TV time and
  // the last lie-in included); the matching below uses the sleep window only.
  const inBed = (s: T, fallback: number) => {
    const t = s.ts ? Date.parse(s.ts) : NaN;
    return isNaN(t) ? fallback : Math.min(t, fallback);
  };
  const outOfBed = (s: T, fallback: number) => {
    const t = s.presenceEnd ? Date.parse(s.presenceEnd) : NaN;
    return isNaN(t) ? fallback : Math.max(t, fallback);
  };
  const from = new Date(Math.min(...spans.map((x) => inBed(x.s, x.start - SOUND_LEAD_MS))));
  const to = new Date(Math.max(...spans.map((x) => outOfBed(x.s, x.end))));
  // While the projector is on, the room is full of the show: its dialogue and
  // music are not night sounds. Cat sounds and cat movement still count.
  const screen = await screenEventsBetween(from, to);
  const screenOn = (t: number): boolean => {
    let on = false;
    for (const e of screen) {
      if (e.at.getTime() > t) break;
      on = e.state === "on";
    }
    return on;
  };
  const events = (await soundEventsBetween(from, to)).filter(
    (e) => e.kind.startsWith("cat") || !screenOn(e.at.getTime()),
  );
  if (events.length === 0) return;
  for (const { s, start, end } of spans) {
    const from = inBed(s, start - SOUND_LEAD_MS);
    const to = outOfBed(s, end);
    s.soundEvents = events.filter((e) => {
      const t = e.at.getTime();
      return t >= from && t <= to;
    });
    s.sound = soundNight(
      events,
      start,
      end,
      wakeUpTimes(s.timeseries?.shortAwakes, start, end),
      (s.timeseries?.tnt ?? []).map(([ts]) => Date.parse(ts)).filter((t) => !isNaN(t)),
    );
  }
}
