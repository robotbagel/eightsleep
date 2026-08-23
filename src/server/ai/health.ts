// health.ts
// Apple Health sleep import: parses what an iPhone Shortcut posts each
// morning, computes a transparent 0-100 sleep score, stores one row per
// night, and exposes the nights in the same shape the AI advisor consumes.
//
// Two accepted payload formats (the endpoint auto-detects):
// 1. `samples`: newline-separated lines "Stage,ISO start,ISO end" straight
//    from a Shortcuts repeat loop over sleep samples. Stages: Deep, REM,
//    Core, Awake, Asleep, InBed (case-insensitive, extra words ignored).
// 2. Aggregate JSON fields (asleepHours, deepHours, remHours, coreHours,
//    awakeHours, wakeCount, avgHeartRate, hrv, respiratoryRate, sleepStart,
//    sleepEnd) for anyone who prefers to precompute.
import { z } from "zod";
import { db } from "~/server/db";
import { healthNights } from "~/server/db/schema";
import { and, desc, eq, gte } from "drizzle-orm";
import { type NightTrend, type SessionDetail } from "./sleepData";

export const HealthImportSchema = z.object({
  samples: z.string().max(200_000).optional(),
  asleepHours: z.number().min(0).max(24).optional(),
  deepHours: z.number().min(0).max(24).optional(),
  remHours: z.number().min(0).max(24).optional(),
  coreHours: z.number().min(0).max(24).optional(),
  awakeHours: z.number().min(0).max(24).optional(),
  wakeCount: z.number().int().min(0).max(200).optional(),
  avgHeartRate: z.number().min(20).max(250).optional(),
  hrv: z.number().min(0).max(500).optional(),
  respiratoryRate: z.number().min(4).max(60).optional(),
  sleepStart: z.string().optional(),
  sleepEnd: z.string().optional(),
});

export type HealthImport = z.infer<typeof HealthImportSchema>;

interface ParsedNight {
  asleepHours: number;
  deepHours: number | null;
  remHours: number | null;
  coreHours: number | null;
  awakeHours: number | null;
  wakeCount: number | null;
  sleepStart: Date | null;
  sleepEnd: Date | null;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

// iOS Shortcuts renders a Date magic variable in the device's locale, not ISO
// 8601 — e.g. "24/08/2026, 05:00", "8/24/2026, 5:00 AM", or "24 Aug 2026 at
// 05:00". This parses the common shapes; day-first vs month-first is
// disambiguated by any component > 12, defaulting to day-first (most non-US
// locales) when ambiguous.
function parseFlexibleDate(raw: string): number {
  const s = raw.trim();
  if (!s) return NaN;

  const native = new Date(s).getTime();
  if (!isNaN(native)) return native;

  // Replace " at " (localized date-time joiner) with a space and retry.
  const deAt = new Date(s.replace(/\s+at\s+/i, " ")).getTime();
  if (!isNaN(deAt)) return deAt;

  // Numeric D/M/Y or M/D/Y with optional time and AM/PM.
  const m = s.match(
    /^(\d{1,4})[/.\-](\d{1,2})[/.\-](\d{1,4})(?:[,\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?)?/i,
  );
  if (m) {
    let a = Number(m[1]);
    let b = Number(m[2]);
    let year = Number(m[3]);
    // ISO-ish YYYY/MM/DD when the first field is the 4-digit year.
    if (m[1]!.length === 4) {
      year = a;
      const month = b;
      const day = Number(m[3]);
      return buildDate(year, month, day, m);
    }
    let day: number;
    let month: number;
    if (a > 12 && b <= 12) {
      day = a;
      month = b;
    } else if (b > 12 && a <= 12) {
      day = b;
      month = a;
    } else {
      // Ambiguous → day-first (non-US default).
      day = a;
      month = b;
    }
    if (year < 100) year += 2000;
    return buildDate(year, month, day, m);
  }
  return NaN;
}

function buildDate(
  year: number,
  month: number,
  day: number,
  m: RegExpMatchArray,
): number {
  let hour = m[4] != null ? Number(m[4]) : 0;
  const minute = m[5] != null ? Number(m[5]) : 0;
  const second = m[6] != null ? Number(m[6]) : 0;
  const ampm = m[7]?.toLowerCase();
  if (ampm === "pm" && hour < 12) hour += 12;
  if (ampm === "am" && hour === 12) hour = 0;
  const d = new Date(year, month - 1, day, hour, minute, second);
  return d.getTime();
}

interface Interval {
  from: number;
  to: number;
  stage: string;
}

// Merges overlapping/adjacent intervals (within `gapMs`) into a union and
// returns the merged blocks. Input need not be sorted.
function mergeIntervals(
  intervals: { from: number; to: number }[],
  gapMs = 60_000,
): { from: number; to: number }[] {
  if (intervals.length === 0) return [];
  const sorted = intervals.slice().sort((a, b) => a.from - b.from);
  const merged = [{ ...sorted[0]! }];
  for (const current of sorted.slice(1)) {
    const last = merged[merged.length - 1]!;
    if (current.from <= last.to + gapMs) {
      last.to = Math.max(last.to, current.to);
    } else {
      merged.push({ ...current });
    }
  }
  return merged;
}

function unionHours(intervals: { from: number; to: number }[]): number {
  return (
    mergeIntervals(intervals, 0).reduce((sum, i) => sum + (i.to - i.from), 0) /
    3_600_000
  );
}

function parseSampleLines(samples: string): ParsedNight | null {
  // 1. Parse every line into a stage interval.
  const intervals: Interval[] = [];
  for (const rawLine of samples.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split(",").map((part) => part.trim());
    // Locale dates can contain a comma ("24/08/2026, 05:00"), which splits
    // into extra fields. First field is the stage; the rest rejoin into the
    // two dates around the midpoint.
    if (parts.length < 3) continue;
    const stageRaw = parts[0]!.toLowerCase();
    let from: number;
    let to: number;
    if (parts.length === 3) {
      from = parseFlexibleDate(parts[1]!);
      to = parseFlexibleDate(parts[2]!);
    } else {
      const rest = parts.slice(1);
      const mid = Math.floor(rest.length / 2);
      from = parseFlexibleDate(rest.slice(0, mid).join(", "));
      to = parseFlexibleDate(rest.slice(mid).join(", "));
    }
    if (isNaN(from) || isNaN(to) || to <= from) continue;

    let stage: string | null = null;
    if (stageRaw.includes("deep")) stage = "deep";
    else if (stageRaw.includes("rem")) stage = "rem";
    else if (stageRaw.includes("core")) stage = "core";
    else if (stageRaw.includes("awake") || stageRaw.includes("wake")) stage = "awake";
    else if (stageRaw.includes("asleep")) stage = "asleep";
    else continue; // InBed wraps everything — skip

    intervals.push({ from, to, stage });
  }
  if (intervals.length === 0) return null;

  // 2. The "last 1 day" filter can span TWO nights — cluster all samples by
  // time gaps (> 4h apart = separate night) and keep the most recent
  // cluster only.
  const clusters = mergeIntervals(intervals, 4 * 60 * 60 * 1000);
  const lastCluster = clusters[clusters.length - 1]!;
  const night = intervals.filter(
    (i) => i.from >= lastCluster.from && i.to <= lastCluster.to,
  );

  // 3. Watch + iPhone both write sleep data, producing overlapping duplicate
  // segments. Compute every figure as an interval UNION, never a sum.
  const byStage = (stage: string) => night.filter((i) => i.stage === stage);
  const deepH = unionHours(byStage("deep"));
  const remH = unionHours(byStage("rem"));
  const coreH = unionHours(byStage("core"));
  const plainAsleepH = unionHours(byStage("asleep"));
  const awakeBlocks = mergeIntervals(byStage("awake"), 2 * 60_000);
  const awakeH = awakeBlocks.reduce((s, i) => s + (i.to - i.from), 0) / 3_600_000;

  const asleepIntervals = night.filter((i) => i.stage !== "awake");
  const asleep =
    deepH + remH + coreH > 0 ? unionHours(asleepIntervals.filter((i) => i.stage !== "asleep")) : plainAsleepH;
  if (asleep <= 0) return null;

  const start = Math.min(...asleepIntervals.map((i) => i.from));
  const end = Math.max(...asleepIntervals.map((i) => i.to));
  const hasStages = deepH + remH + coreH > 0;

  return {
    asleepHours: round1(asleep),
    deepHours: hasStages ? round1(deepH) : null,
    remHours: hasStages ? round1(remH) : null,
    coreHours: hasStages ? round1(coreH) : null,
    awakeHours: awakeBlocks.length > 0 ? round1(awakeH) : null,
    wakeCount: awakeBlocks.length > 0 ? awakeBlocks.length : null,
    sleepStart: new Date(start),
    sleepEnd: new Date(end),
  };
}

// Transparent score, 0-100, mirroring the Apple Watch Sleep Score rubric
// (Duration up to 50, Bedtime consistency up to 30, Interruptions up to 20):
// - Duration: 50 x min(asleep / 8.5h, 1)
// - Bedtime: 30 minus 1 point per 6 minutes of deviation from the reference
//   bedtime (the trailing average of past imports, or the scheduled bedtime
//   for the first night); floor 0.
// - Interruptions: 20 minus 1 per merged awakening minus 5 per awake hour;
//   floor 0. Neutral 14 when awakenings are unknown.
export function computeSleepScore(
  night: ParsedNight,
  referenceBedtimeMs: number | null = null,
): number {
  const duration = 50 * Math.min(night.asleepHours / 8.5, 1);

  let bedtime = 24; // neutral when no reference is available
  if (referenceBedtimeMs != null && night.sleepStart != null) {
    const minutesOfDay = (ms: number) => {
      const d = new Date(ms);
      return d.getHours() * 60 + d.getMinutes();
    };
    let dev = Math.abs(
      minutesOfDay(night.sleepStart.getTime()) - minutesOfDay(referenceBedtimeMs),
    );
    if (dev > 12 * 60) dev = 24 * 60 - dev; // wrap around midnight
    bedtime = Math.max(30 - dev / 6, 0);
  }

  const interruptions =
    night.wakeCount != null
      ? Math.max(20 - night.wakeCount - 5 * (night.awakeHours ?? 0), 0)
      : 14;

  return Math.round(duration + bedtime + interruptions);
}

export interface StoredHealthNight {
  night: string;
  score: number;
}

export async function storeHealthImport(
  email: string,
  payload: HealthImport,
  timezone: string,
): Promise<StoredHealthNight> {
  let parsed: ParsedNight | null = null;
  if (payload.samples) {
    parsed = parseSampleLines(payload.samples);
  }
  if (!parsed && payload.asleepHours != null) {
    parsed = {
      asleepHours: payload.asleepHours,
      deepHours: payload.deepHours ?? null,
      remHours: payload.remHours ?? null,
      coreHours: payload.coreHours ?? null,
      awakeHours: payload.awakeHours ?? null,
      wakeCount: payload.wakeCount ?? null,
      sleepStart: payload.sleepStart ? new Date(payload.sleepStart) : null,
      sleepEnd: payload.sleepEnd ? new Date(payload.sleepEnd) : null,
    };
  }
  if (!parsed) {
    throw new Error(
      "No usable sleep data in the payload: provide `samples` lines or `asleepHours`.",
    );
  }

  const reference =
    parsed.sleepEnd ??
    (payload.sleepEnd ? new Date(payload.sleepEnd) : new Date());
  const night = reference.toLocaleDateString("en-CA", { timeZone: timezone });

  // Bedtime reference: circular mean of the last 14 imported bedtimes.
  let referenceBedtimeMs: number | null = null;
  const prior = await db
    .select()
    .from(healthNights)
    .where(eq(healthNights.email, email))
    .orderBy(desc(healthNights.night))
    .limit(14);
  const starts = prior
    .filter((row) => row.night !== night && row.sleepStart != null)
    .map((row) => row.sleepStart!.getTime());
  if (starts.length > 0) {
    let sx = 0;
    let sy = 0;
    for (const ms of starts) {
      const d = new Date(ms);
      const angle = ((d.getHours() * 60 + d.getMinutes()) / 1440) * 2 * Math.PI;
      sx += Math.cos(angle);
      sy += Math.sin(angle);
    }
    let meanMinutes = (Math.atan2(sy, sx) / (2 * Math.PI)) * 1440;
    if (meanMinutes < 0) meanMinutes += 1440;
    const ref = new Date();
    ref.setHours(Math.floor(meanMinutes / 60), Math.round(meanMinutes % 60), 0, 0);
    referenceBedtimeMs = ref.getTime();
  }

  const score = computeSleepScore(parsed, referenceBedtimeMs);

  const tenth = (hours: number | null) =>
    hours != null ? Math.round(hours * 10) : null;
  const row = {
    email,
    night,
    asleepTenthHours: Math.round(parsed.asleepHours * 10),
    deepTenthHours: tenth(parsed.deepHours),
    remTenthHours: tenth(parsed.remHours),
    coreTenthHours: tenth(parsed.coreHours),
    awakeTenthHours: tenth(parsed.awakeHours),
    wakeCount: parsed.wakeCount,
    avgHeartRate:
      payload.avgHeartRate != null ? Math.round(payload.avgHeartRate) : null,
    hrv: payload.hrv != null ? Math.round(payload.hrv) : null,
    respiratoryRateTenths:
      payload.respiratoryRate != null
        ? Math.round(payload.respiratoryRate * 10)
        : null,
    score,
    sleepStart: parsed.sleepStart,
    sleepEnd: parsed.sleepEnd,
    updatedAt: new Date(),
  };

  await db
    .insert(healthNights)
    .values(row)
    .onConflictDoUpdate({
      target: [healthNights.email, healthNights.night],
      set: row,
    })
    .execute();

  return { night, score };
}

// Converts stored Apple Health nights into the advisor's context shapes so
// the same optimizer runs whether the data source is the pod or the watch.
export async function getHealthContext(
  email: string,
  days = 7,
): Promise<{ nights: NightTrend[]; recentSessions: SessionDetail[] }> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const rows = await db
    .select()
    .from(healthNights)
    .where(and(eq(healthNights.email, email), gte(healthNights.night, since)))
    .orderBy(desc(healthNights.night))
    .limit(days);

  const nights: NightTrend[] = rows
    .slice()
    .reverse()
    .map((row) => ({
      date: row.night,
      score: row.score,
      sleepDurationHours: row.asleepTenthHours / 10,
      hrv: row.hrv,
      restingHeartRate: row.avgHeartRate,
      respiratoryRate:
        row.respiratoryRateTenths != null
          ? row.respiratoryRateTenths / 10
          : null,
    }));

  const recentSessions: SessionDetail[] = rows.slice(0, 3).map((row) => {
    const stageHours: Record<string, number> = {};
    if (row.deepTenthHours != null) stageHours.deep = row.deepTenthHours / 10;
    if (row.remTenthHours != null) stageHours.rem = row.remTenthHours / 10;
    if (row.coreTenthHours != null) stageHours.light = row.coreTenthHours / 10;
    if (row.awakeTenthHours != null) stageHours.awake = row.awakeTenthHours / 10;
    return {
      date: row.night,
      score: row.score,
      stageHours,
      tossesAndTurns: { firstThird: null, middleThird: null, finalThird: null },
      avgBedTempC: { firstThird: null, middleThird: null, finalThird: null },
      avgRoomTempC: null,
      avgHeartRate: row.avgHeartRate,
    };
  });

  return { nights, recentSessions };
}
