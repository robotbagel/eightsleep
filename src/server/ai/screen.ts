// screen.ts
// "Were they watching TV, or trying to sleep?"
//
// The pod measures sleep-onset latency as the time between getting into bed
// and falling asleep. In this household the first 40-45 minutes in bed are
// two episodes on the bedroom projector, so the pod reported 30-84 minutes
// "to fall asleep" night after night (Sep 2026), the score docked it, and the
// autopilot's latency signal kept treating a TV habit as a sleep problem.
//
// The projector's Chromecast with Google TV reports over HDMI-CEC whether the
// screen is actually on. A watcher on the NAS (deploy/screen-watch) posts each
// on/off change to /api/screenEvent. Here those changes are laid over a night:
// how long the screen was on in bed, when it went off ("lights out"), and the
// latency that counts, measured from lights out rather than from getting in.
//
// The bedroom has one screen and two sides, so the events are household-wide
// and apply to both accounts.

import { and, asc, desc, gte, lte } from "drizzle-orm";
import { db } from "~/server/db";
import { screenEvents } from "~/server/db/schema";

export interface ScreenEvent {
  at: Date;
  state: "on" | "off";
}

export interface ScreenNight {
  /** Minutes the screen was on between getting into bed and falling asleep. */
  inBedMinutes: number;
  /** When the screen went off for the night, ISO; null if it never did in time. */
  offAt: string | null;
  /** Latency measured from lights out, in hours; replaces the pod's figure. */
  latencyHours: number;
  /** Fell asleep with the screen still on. */
  fellAsleepWatching: boolean;
}

/** Events this long before getting into bed still decide the starting state. */
const LOOKBACK_MS = 6 * 3_600_000;
/** A screen switched off this soon after sleep onset was on while dozing off. */
const DOZE_MS = 30 * 60_000;

/**
 * Lays the screen's on/off changes over one night. Pure. `events` must be
 * sorted oldest first and may extend well beyond the night. Returns null when
 * the screen was not on at any point between getting into bed and sleep, so
 * a night without TV keeps the pod's own latency untouched.
 */
export function screenNight(
  events: ScreenEvent[],
  inBedAt: Date,
  sleepStartAt: Date,
): ScreenNight | null {
  const inBed = inBedAt.getTime();
  const asleep = sleepStartAt.getTime();
  if (!(asleep >= inBed)) return null;

  // Turn the changes into on-intervals.
  const intervals: [number, number][] = [];
  let onSince: number | null = null;
  for (const event of events) {
    const t = event.at.getTime();
    if (event.state === "on" && onSince == null) onSince = t;
    if (event.state === "off" && onSince != null) {
      intervals.push([onSince, t]);
      onSince = null;
    }
  }
  if (onSince != null) intervals.push([onSince, Infinity]);

  // Screen time in bed before sleep.
  let onMs = 0;
  for (const [from, to] of intervals) {
    const overlap = Math.min(to, asleep) - Math.max(from, inBed);
    if (overlap > 0) onMs += overlap;
  }
  if (onMs <= 0) return null;

  // Lights out: the end of the last stretch that was on before sleep.
  const before = intervals.filter(([from]) => from < asleep);
  const last = before[before.length - 1]!;
  const offAt = last[1];
  const fellAsleepWatching = offAt > asleep;
  return {
    inBedMinutes: Math.round(onMs / 60_000),
    offAt: isFinite(offAt) ? new Date(offAt).toISOString() : null,
    latencyHours: fellAsleepWatching ? 0 : (asleep - offAt) / 3_600_000,
    fellAsleepWatching,
  };
}

/** Screen changes in a window, oldest first. Never throws: no data = no TV. */
export async function screenEventsBetween(from: Date, to: Date): Promise<ScreenEvent[]> {
  try {
    const rows = await db
      .select({ at: screenEvents.at, state: screenEvents.state })
      .from(screenEvents)
      .where(and(gte(screenEvents.at, from), lte(screenEvents.at, to)))
      .orderBy(asc(screenEvents.at));
    // The state at the start of the window, so a screen switched on before it
    // still counts as on.
    const prior = await db
      .select({ at: screenEvents.at, state: screenEvents.state })
      .from(screenEvents)
      .where(lte(screenEvents.at, from))
      .orderBy(desc(screenEvents.at))
      .limit(1);
    return [...prior, ...rows]
      .filter((r) => r.state === "on" || r.state === "off")
      .map((r) => ({ at: r.at, state: r.state as "on" | "off" }));
  } catch (error) {
    console.error(
      "Screen events unreadable, ignoring TV time:",
      error instanceof Error ? error.message : String(error),
    );
    return [];
  }
}

/** Minimal shape of a pod session this module reads. */
interface SessionTimes {
  ts?: string | null;
  sleepStart?: string | null;
  stageSummary?: { awakeBeforeSleepDuration?: number | null } | null;
}

/** When they got into bed: the session start, else sleep start minus latency. */
export function inBedAt(session: SessionTimes): Date | null {
  if (!session.sleepStart) return null;
  const sleep = Date.parse(session.sleepStart);
  if (isNaN(sleep)) return null;
  const start = session.ts ? Date.parse(session.ts) : NaN;
  if (!isNaN(start) && start <= sleep) return new Date(start);
  const before = session.stageSummary?.awakeBeforeSleepDuration;
  return before != null ? new Date(sleep - before * 1000) : null;
}

/**
 * Attach each session's screen time, in place, from ONE read covering the
 * whole batch. Every session the app reads passes through here, so the
 * latency every consumer sees (score, signals, the model, the UI) is already
 * measured from lights out.
 */
export async function attachScreenTime<T extends SessionTimes & { screen?: ScreenNight | null }>(
  sessions: T[],
): Promise<void> {
  const spans = sessions
    .map((s) => ({ s, inBed: inBedAt(s), asleep: s.sleepStart ? new Date(s.sleepStart) : null }))
    .filter((x): x is { s: T; inBed: Date; asleep: Date } => x.inBed != null && x.asleep != null);
  if (spans.length === 0) return;
  const from = new Date(Math.min(...spans.map((x) => x.inBed.getTime())) - LOOKBACK_MS);
  const to = new Date(Math.max(...spans.map((x) => x.asleep.getTime())) + DOZE_MS);
  const events = await screenEventsBetween(from, to);
  if (events.length === 0) return;
  for (const { s, inBed, asleep } of spans) {
    s.screen = screenNight(events, inBed, asleep);
  }
}
