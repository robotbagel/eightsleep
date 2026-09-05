// history.ts
// Long-range sleep history: turns raw pod sessions into one row per night,
// caches them in `8slp_nightMetrics`, and answers 7 / 14 / 30-day comparison
// questions from the cache.
//
// Why a cache: the sessions endpoint returns the newest ~10 sessions per page
// and only pages backwards through an opaque cursor, so a 30-day view costs
// three or four round trips carrying full timeseries. Nights never change
// once they are complete, so we store the summary the first time we see it.
import { db } from "~/server/db";
import { healthNights, nightMetrics } from "~/server/db/schema";
import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { type Token } from "../eight/types";
import {
  awakeAfterOnsetHours,
  fetchPodSessions,
  sleepLatencyHours,
  wakeEventCount,
  type PodSession,
} from "./sleepData";
import { compareSources, type SecondOpinion } from "./secondOpinion";
import {
  BEDTIME_REFERENCE_NIGHTS,
  circularMeanMinutes,
  minutesOfDayInZone,
  scoreNight,
  thermalScore,
} from "./score";

export interface NightMetric {
  night: string; // wake date, YYYY-MM-DD, the app's night key everywhere
  score: number | null;
  /** Sleep quality attributable to temperature; the control loop's target. */
  thermalScore: number | null;
  asleepHours: number | null;
  inBedHours: number | null;
  deepHours: number | null;
  remHours: number | null;
  lightHours: number | null;
  awakeHours: number | null;
  /** Hours in bed before falling asleep (sleep-onset latency). */
  sleepLatencyHours: number | null;
  tosses: number | null;
  wakeCount: number | null;
  restingHeartRate: number | null;
  avgHeartRate: number | null;
  hrv: number | null;
  respiratoryRate: number | null;
  avgBedTempC: number | null;
  avgRoomTempC: number | null;
  bedtimeMinutes: number | null; // minutes past midnight, local
  wakeMinutes: number | null;
  source: "pod" | "health";
  /** The Apple Watch's reading of the same night, when one was imported. */
  secondOpinion?: SecondOpinion | null;
}

const tenth = (value: number | null | undefined): number | null =>
  value == null || !isFinite(value) ? null : Math.round(value * 10);
const fromTenth = (value: number | null | undefined): number | null =>
  value == null ? null : Math.round(value) / 10;

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** How many pages of ~10 sessions we need to cover `days` nights, plus slack. */
export function pagesForDays(days: number): number {
  return Math.min(5, Math.max(1, Math.ceil((days + 4) / 9)));
}

export function metricsFromSession(
  session: PodSession,
  timezone: string,
  referenceBedtimeMinutes: number | null,
): NightMetric | null {
  if (!session.sleepEnd) return null;
  const summary = session.stageSummary ?? {};
  const asleepSeconds = summary.sleepDuration ?? 0;
  if (asleepSeconds <= 0) return null;

  const night = new Date(session.sleepEnd).toLocaleDateString("en-CA", {
    timeZone: timezone,
  });
  const start = session.sleepStart ? new Date(session.sleepStart) : null;
  const end = new Date(session.sleepEnd);
  const timeseries = session.timeseries ?? {};

  const heartRates = (timeseries.heartRate ?? []).map(([, v]) => v);
  const hrvSeries = (timeseries.rmssd ?? timeseries.hrv ?? []).map(([, v]) => v);
  const respiratory = (
    timeseries.respiratoryRate ??
    timeseries.nemeanRespiratoryRate ??
    []
  ).map(([, v]) => v);
  const bedTemps = (timeseries.tempBedC ?? []).map(([, v]) => v);
  const roomTemps = (timeseries.tempRoomC ?? []).map(([, v]) => v);
  const bedtimeMinutes =
    start && !isNaN(start.getTime())
      ? minutesOfDayInZone(start, timezone)
      : null;
  // Awake AFTER sleep onset only — see awakeAfterOnsetHours(). Feeding the
  // pod's total awakeDuration here charged reading in bed as interruptions
  // in both scores below.
  const awakeHours = awakeAfterOnsetHours(session);
  const wakeCount = wakeEventCount(session);
  const latencyHours = sleepLatencyHours(session);

  const asleepHours = asleepSeconds / 3600;
  const deepHours = (summary.deepDuration ?? 0) / 3600;
  const remHours = (summary.remDuration ?? 0) / 3600;
  const tosses = (timeseries.tnt ?? []).length;

  return {
    night,
    thermalScore: thermalScore({
      asleepHours,
      deepHours,
      remHours,
      awakeHours,
      tosses,
      latencyMinutes: latencyHours == null ? null : Math.round(latencyHours * 60),
    }),
    score: scoreNight({
      asleepHours: asleepSeconds / 3600,
      awakeHours,
      wakeCount,
      bedtimeMinutes,
      referenceBedtimeMinutes,
    }),
    asleepHours: asleepSeconds / 3600,
    inBedHours:
      start && !isNaN(start.getTime())
        ? (end.getTime() - start.getTime()) / 3_600_000
        : null,
    deepHours: (summary.deepDuration ?? 0) / 3600,
    remHours: (summary.remDuration ?? 0) / 3600,
    lightHours: (summary.lightDuration ?? 0) / 3600,
    awakeHours,
    sleepLatencyHours: latencyHours,
    tosses: (timeseries.tnt ?? []).length,
    wakeCount,
    restingHeartRate: heartRates.length > 0 ? Math.min(...heartRates) : null,
    avgHeartRate: mean(heartRates),
    hrv: mean(hrvSeries),
    respiratoryRate: mean(respiratory),
    avgBedTempC: mean(bedTemps),
    avgRoomTempC: mean(roomTemps),
    bedtimeMinutes,
    wakeMinutes: minutesOfDayInZone(end, timezone),
    source: "pod",
  };
}

/**
 * Fetches `pages` of pod sessions, converts them to night metrics and writes
 * them into the cache (replacing any existing row for the same night, since a
 * night can still be re-scored while the reference bedtime moves).
 */
/** Converts a batch of raw pod sessions into one metric row per night. */
export function sessionsToMetrics(
  sessions: PodSession[],
  timezone: string,
): NightMetric[] {
  const usable = sessions
    .filter((s) => (s.stageSummary?.sleepDuration ?? 0) > 0 && s.sleepEnd)
    .sort((a, b) => (a.sleepEnd! < b.sleepEnd! ? -1 : 1));
  if (usable.length === 0) return [];

  // Bedtime consistency is scored against the circular mean of the nights
  // BEFORE each one (up to BEDTIME_REFERENCE_NIGHTS, as Apple does), so a
  // night is judged against the habit it followed, not against itself or
  // nights that came later.
  const bedtimes = usable.map((s) => {
    const d = s.sleepStart ? new Date(s.sleepStart) : null;
    return d != null && !isNaN(d.getTime()) ? minutesOfDayInZone(d, timezone) : null;
  });

  return usable
    .map((session, index) => {
      const prior = bedtimes
        .slice(Math.max(0, index - BEDTIME_REFERENCE_NIGHTS), index)
        .filter((m): m is number => m != null);
      const reference =
        prior.length > 0 ? circularMeanMinutes(prior) : null;
      return metricsFromSession(session, timezone, reference);
    })
    .filter((m): m is NightMetric => m != null);
}

/**
 * Writes metrics into the cache, replacing any existing row for the same
 * night (a night can be re-scored as the reference bedtime moves). Never
 * throws: a cache write must not take a page down with it.
 */
export async function persistNightMetrics(
  email: string,
  metrics: NightMetric[],
  options: { rescore?: boolean } = {},
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (metrics.length === 0) return { ok: true };
  try {
    const nights = metrics.map((m) => m.night);

    // A night's score is FROZEN once stored. The bedtime-consistency term is
    // measured against the circular mean of whatever window we happen to
    // hold, so re-scoring an old night as the window slides moves history
    // under the experiment loop's feet — the same night was reported as 75
    // one day and 74 the next. Measurements are refreshed; the score is not.
    const existing = await db
      .select({
        night: nightMetrics.night,
        score: nightMetrics.score,
        thermalScore: nightMetrics.thermalScore,
      })
      .from(nightMetrics)
      .where(
        and(eq(nightMetrics.email, email), inArray(nightMetrics.night, nights)),
      );
    // `rescore` is the one deliberate exception: after the rubric itself
    // changes, every held night is re-scored on the new basis in one pass
    // (aiDebug?action=rescore), so history stays comparable with itself.
    const frozen = new Map(
      options.rescore
        ? []
        : existing
            .filter((row) => row.score != null)
            .map((row) => [row.night, row.score!]),
    );
    const frozenThermal = new Map(
      options.rescore
        ? []
        : existing
            .filter((row) => row.thermalScore != null)
            .map((row) => [row.night, row.thermalScore!]),
    );

    // Delete + insert in ONE transaction. On 2026-09-05 the insert failed
    // (a column the schema push had not created) after the delete had
    // already run, and both accounts' cached nights vanished — the writer
    // "never throws", so nothing said so either. Now a failed insert keeps
    // the old rows, and the failure is returned to the caller.
    await db.transaction(async (tx) => {
      await tx
        .delete(nightMetrics)
        .where(
          and(eq(nightMetrics.email, email), inArray(nightMetrics.night, nights)),
        );
      await tx.insert(nightMetrics).values(
        metrics.map((m) => ({
        email,
        night: m.night,
        score: frozen.get(m.night) ?? m.score,
        thermalScore: frozenThermal.get(m.night) ?? m.thermalScore,
        asleepTenthHours: tenth(m.asleepHours),
        inBedTenthHours: tenth(m.inBedHours),
        deepTenthHours: tenth(m.deepHours),
        remTenthHours: tenth(m.remHours),
        lightTenthHours: tenth(m.lightHours),
        awakeTenthHours: tenth(m.awakeHours),
        latencyTenthHours: tenth(m.sleepLatencyHours),
        tosses: m.tosses,
        wakeCount: m.wakeCount,
        restingHeartRate:
          m.restingHeartRate == null ? null : Math.round(m.restingHeartRate),
        avgHeartRate:
          m.avgHeartRate == null ? null : Math.round(m.avgHeartRate),
        hrv: m.hrv == null ? null : Math.round(m.hrv),
        respiratoryTenth: tenth(m.respiratoryRate),
        avgBedTempTenthC: tenth(m.avgBedTempC),
        avgRoomTempTenthC: tenth(m.avgRoomTempC),
        bedtimeMinutes: m.bedtimeMinutes,
        wakeMinutes: m.wakeMinutes,
        source: m.source,
      })),
      );
    });
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to cache night metrics for ${email}:`, message);
    return { ok: false, error: message };
  }
}

/**
 * Pages of pod sessions to pull when a night is first stored. Two, not one:
 * the bedtime-consistency term is measured against up to
 * BEDTIME_REFERENCE_NIGHTS prior nights and then frozen, and one page (~10
 * nights) left the newest night judged against at most nine.
 */
export const SYNC_PAGES = 2;

export async function syncNightMetrics(
  email: string,
  token: Token,
  userId: string,
  timezone: string,
  pages: number,
): Promise<NightMetric[]> {
  const metrics = sessionsToMetrics(
    await fetchPodSessions(token, userId, pages),
    timezone,
  );
  await persistNightMetrics(email, metrics);
  return metrics;
}

function rowToMetric(row: typeof nightMetrics.$inferSelect): NightMetric {
  return {
    night: row.night,
    score: row.score,
    thermalScore: row.thermalScore,
    asleepHours: fromTenth(row.asleepTenthHours),
    inBedHours: fromTenth(row.inBedTenthHours),
    deepHours: fromTenth(row.deepTenthHours),
    remHours: fromTenth(row.remTenthHours),
    lightHours: fromTenth(row.lightTenthHours),
    awakeHours: fromTenth(row.awakeTenthHours),
    sleepLatencyHours: fromTenth(row.latencyTenthHours),
    tosses: row.tosses,
    wakeCount: row.wakeCount,
    restingHeartRate: row.restingHeartRate,
    avgHeartRate: row.avgHeartRate,
    hrv: row.hrv,
    respiratoryRate: fromTenth(row.respiratoryTenth),
    avgBedTempC: fromTenth(row.avgBedTempTenthC),
    avgRoomTempC: fromTenth(row.avgRoomTempTenthC),
    bedtimeMinutes: row.bedtimeMinutes,
    wakeMinutes: row.wakeMinutes,
    source: row.source === "health" ? "health" : "pod",
  };
}

export function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Apple Health nights fill gaps the pod did not record. Pod always wins. */
async function readHealthNights(
  email: string,
  from: string,
  to: string,
  timezone: string,
): Promise<NightMetric[]> {
  const rows = await db
    .select()
    .from(healthNights)
    .where(
      and(
        eq(healthNights.email, email),
        gte(healthNights.night, from),
        lte(healthNights.night, to),
      ),
    );
  return rows.map((row) => ({
    night: row.night,
    score: row.score,
    // Apple Health carries no toss count, so a thermal score would rest on
    // half the evidence; better absent than misleading.
    thermalScore: null,
    asleepHours: fromTenth(row.asleepTenthHours),
    inBedHours: null,
    deepHours: fromTenth(row.deepTenthHours),
    remHours: fromTenth(row.remTenthHours),
    lightHours: fromTenth(row.coreTenthHours),
    awakeHours: fromTenth(row.awakeTenthHours),
    sleepLatencyHours: null,
    tosses: null,
    wakeCount: row.wakeCount,
    restingHeartRate: null,
    avgHeartRate: row.avgHeartRate,
    hrv: row.hrv,
    respiratoryRate: fromTenth(row.respiratoryRateTenths),
    avgBedTempC: null,
    avgRoomTempC: null,
    // In the sleeper's zone, not the server's (Vercel runs in UTC).
    bedtimeMinutes:
      row.sleepStart == null ? null : minutesOfDayInZone(row.sleepStart, timezone),
    wakeMinutes:
      row.sleepEnd == null ? null : minutesOfDayInZone(row.sleepEnd, timezone),
    source: "health" as const,
  }));
}

export async function readNightMetrics(
  email: string,
  from: string,
  to: string,
  timezone: string,
): Promise<NightMetric[]> {
  const rows = await db
    .select()
    .from(nightMetrics)
    .where(
      and(
        eq(nightMetrics.email, email),
        gte(nightMetrics.night, from),
        lte(nightMetrics.night, to),
      ),
    );
  const byNight = new Map<string, NightMetric>();
  for (const night of await readHealthNights(email, from, to, timezone)) {
    byNight.set(night.night, night);
  }
  for (const row of rows) {
    const metric = rowToMetric(row);
    // Pod wins for the same date, but the Watch's reading rides along as a
    // second opinion so a sensor disagreement is visible instead of lost.
    const watch = byNight.get(metric.night);
    if (watch && watch.source === "health") {
      metric.secondOpinion = compareSources(metric, watch);
    }
    byNight.set(metric.night, metric);
  }
  return [...byNight.values()].sort((a, b) => a.night.localeCompare(b.night));
}

// ---------------------------------------------------------------------------
// Aggregates
// ---------------------------------------------------------------------------

export type MetricKey =
  | "score"
  | "thermalScore"
  | "asleepHours"
  | "deepHours"
  | "remHours"
  | "awakeHours"
  | "sleepLatencyHours"
  | "tosses"
  | "restingHeartRate"
  | "hrv"
  | "respiratoryRate"
  | "avgBedTempC"
  | "bedtimeMinutes";

export interface Aggregate {
  key: MetricKey;
  average: number | null;
  best: number | null;
  worst: number | null;
  nights: number;
  /** Same statistic over the equally long window immediately before. */
  previousAverage: number | null;
}

/** Higher is better for these; the rest read better when they go down. */
export const HIGHER_IS_BETTER: Record<MetricKey, boolean> = {
  score: true,
  thermalScore: true,
  asleepHours: true,
  deepHours: true,
  remHours: true,
  awakeHours: false,
  sleepLatencyHours: false,
  tosses: false,
  restingHeartRate: false,
  hrv: true,
  respiratoryRate: false,
  avgBedTempC: true, // neutral in truth; the UI shows it without a verdict
  bedtimeMinutes: true,
};

const NEUTRAL: MetricKey[] = ["avgBedTempC", "bedtimeMinutes"];
export const isNeutral = (key: MetricKey): boolean => NEUTRAL.includes(key);

function averageOf(nights: NightMetric[], key: MetricKey): number | null {
  const values = nights
    .map((n) => n[key])
    .filter((v): v is number => typeof v === "number" && isFinite(v));
  if (values.length === 0) return null;
  // Bedtime is a clock time: averaging 23:50 and 00:10 linearly gives noon.
  if (key === "bedtimeMinutes") return circularMeanMinutes(values);
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

export function aggregate(
  window: NightMetric[],
  previous: NightMetric[],
  key: MetricKey,
): Aggregate {
  const values = window
    .map((n) => n[key])
    .filter((v): v is number => typeof v === "number" && isFinite(v));
  const better = HIGHER_IS_BETTER[key];
  return {
    key,
    average: averageOf(window, key),
    best:
      values.length === 0
        ? null
        : better
          ? Math.max(...values)
          : Math.min(...values),
    worst:
      values.length === 0
        ? null
        : better
          ? Math.min(...values)
          : Math.max(...values),
    nights: values.length,
    previousAverage: averageOf(previous, key),
  };
}

/** Average of a metric per weekday (0 = Sunday), for the weekday breakdown. */
export function byWeekday(
  nights: NightMetric[],
  key: MetricKey,
): (number | null)[] {
  const buckets: number[][] = Array.from({ length: 7 }, () => []);
  for (const night of nights) {
    const value = night[key];
    if (typeof value !== "number" || !isFinite(value)) continue;
    const weekday = new Date(`${night.night}T12:00:00Z`).getUTCDay();
    buckets[weekday]!.push(value);
  }
  return buckets.map((values) =>
    values.length === 0
      ? null
      : key === "bedtimeMinutes"
        ? circularMeanMinutes(values)
        : values.reduce((sum, v) => sum + v, 0) / values.length,
  );
}
