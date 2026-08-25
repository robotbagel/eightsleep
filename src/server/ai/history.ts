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
import { fetchPodSessions, type PodSession } from "./sleepData";
import { circularMeanMinutes, minutesOfDayInZone, scoreNight } from "./score";

export interface NightMetric {
  night: string; // wake date, YYYY-MM-DD, the app's night key everywhere
  score: number | null;
  asleepHours: number | null;
  inBedHours: number | null;
  deepHours: number | null;
  remHours: number | null;
  lightHours: number | null;
  awakeHours: number | null;
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
  const shortAwakes = timeseries.shortAwakes ?? [];

  const bedtimeMinutes =
    start && !isNaN(start.getTime())
      ? minutesOfDayInZone(start, timezone)
      : null;
  const awakeHours = (summary.awakeDuration ?? 0) / 3600;

  return {
    night,
    score: scoreNight({
      asleepHours: asleepSeconds / 3600,
      awakeHours,
      wakeCount: shortAwakes.length > 0 ? shortAwakes.length : null,
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
    tosses: (timeseries.tnt ?? []).length,
    wakeCount: shortAwakes.length,
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

  // Bedtime consistency is scored against the circular mean of the window we
  // actually have, so a longer window gives a more stable reference.
  const bedtimes = usable
    .map((s) => (s.sleepStart ? new Date(s.sleepStart) : null))
    .filter((d): d is Date => d != null && !isNaN(d.getTime()))
    .map((d) => minutesOfDayInZone(d, timezone));
  const reference = circularMeanMinutes(bedtimes);

  return usable
    .map((session) => metricsFromSession(session, timezone, reference))
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
): Promise<void> {
  if (metrics.length === 0) return;
  try {
    const nights = metrics.map((m) => m.night);

    // A night's score is FROZEN once stored. The bedtime-consistency term is
    // measured against the circular mean of whatever window we happen to
    // hold, so re-scoring an old night as the window slides moves history
    // under the experiment loop's feet — the same night was reported as 75
    // one day and 74 the next. Measurements are refreshed; the score is not.
    const existing = await db
      .select({ night: nightMetrics.night, score: nightMetrics.score })
      .from(nightMetrics)
      .where(
        and(eq(nightMetrics.email, email), inArray(nightMetrics.night, nights)),
      );
    const frozen = new Map(
      existing
        .filter((row) => row.score != null)
        .map((row) => [row.night, row.score!]),
    );

    await db
      .delete(nightMetrics)
      .where(
        and(eq(nightMetrics.email, email), inArray(nightMetrics.night, nights)),
      );
    await db.insert(nightMetrics).values(
      metrics.map((m) => ({
        email,
        night: m.night,
        score: m.score,
        asleepTenthHours: tenth(m.asleepHours),
        inBedTenthHours: tenth(m.inBedHours),
        deepTenthHours: tenth(m.deepHours),
        remTenthHours: tenth(m.remHours),
        lightTenthHours: tenth(m.lightHours),
        awakeTenthHours: tenth(m.awakeHours),
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
  } catch (error) {
    console.error(
      `Failed to cache night metrics for ${email}:`,
      error instanceof Error ? error.message : String(error),
    );
  }
}

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
    asleepHours: fromTenth(row.asleepTenthHours),
    inBedHours: fromTenth(row.inBedTenthHours),
    deepHours: fromTenth(row.deepTenthHours),
    remHours: fromTenth(row.remTenthHours),
    lightHours: fromTenth(row.lightTenthHours),
    awakeHours: fromTenth(row.awakeTenthHours),
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
    asleepHours: fromTenth(row.asleepTenthHours),
    inBedHours: null,
    deepHours: fromTenth(row.deepTenthHours),
    remHours: fromTenth(row.remTenthHours),
    lightHours: fromTenth(row.coreTenthHours),
    awakeHours: fromTenth(row.awakeTenthHours),
    tosses: null,
    wakeCount: row.wakeCount,
    restingHeartRate: null,
    avgHeartRate: row.avgHeartRate,
    hrv: row.hrv,
    respiratoryRate: fromTenth(row.respiratoryRateTenths),
    avgBedTempC: null,
    avgRoomTempC: null,
    bedtimeMinutes:
      row.sleepStart == null
        ? null
        : row.sleepStart.getHours() * 60 + row.sleepStart.getMinutes(),
    wakeMinutes:
      row.sleepEnd == null
        ? null
        : row.sleepEnd.getHours() * 60 + row.sleepEnd.getMinutes(),
    source: "health" as const,
  }));
}

export async function readNightMetrics(
  email: string,
  from: string,
  to: string,
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
  for (const night of await readHealthNights(email, from, to)) {
    byNight.set(night.night, night);
  }
  for (const row of rows) {
    const metric = rowToMetric(row);
    byNight.set(metric.night, metric); // pod overwrites health for the same date
  }
  return [...byNight.values()].sort((a, b) => a.night.localeCompare(b.night));
}

// ---------------------------------------------------------------------------
// Aggregates
// ---------------------------------------------------------------------------

export type MetricKey =
  | "score"
  | "asleepHours"
  | "deepHours"
  | "remHours"
  | "awakeHours"
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
  asleepHours: true,
  deepHours: true,
  remHours: true,
  awakeHours: false,
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
