// sleepData.ts
// Collects recent sleep metrics from the Eight Sleep API and compresses them
// into a compact context object for the AI advisor.
//
// The schemas here are intentionally forgiving: the Eight Sleep API omits
// fields freely depending on device/firmware/data availability, and a strict
// parse (like the ones in ../eight/types.ts) breaks in production. Anything
// missing becomes null and is simply absent from the AI context.
import { z } from "zod";
import { fetchWithAuth } from "../eight/eight";
import { CLIENT_API_URL } from "../eight/constants";
import { type Token } from "../eight/types";

const ForgivingTrendsSchema = z.object({
  result: z
    .object({
      days: z
        .array(
          z
            .object({
              day: z.string(),
              score: z.number().nullish(),
              sleepDuration: z.number().nullish(),
              sleepQualityScore: z
                .object({
                  total: z.number().nullish(),
                  hrv: z.object({ current: z.number().nullish() }).nullish(),
                  respiratoryRate: z
                    .object({ current: z.number().nullish() })
                    .nullish(),
                })
                .nullish(),
              sleepRoutineScore: z
                .object({
                  total: z.number().nullish(),
                  heartRate: z.object({ current: z.number().nullish() }).nullish(),
                })
                .nullish(),
            })
            .catchall(z.unknown()),
        )
        .nullish(),
    })
    .nullish(),
});

const timeseriesPoint = z.tuple([z.string(), z.number()]);

const ForgivingIntervalsSchema = z.object({
  result: z
    .object({
      intervals: z
        .array(
          z
            .object({
              id: z.string().nullish(),
              ts: z.string().nullish(),
              score: z.number().nullish(),
              incomplete: z.boolean().nullish(),
              stages: z
                .array(
                  z.object({
                    stage: z.string(),
                    duration: z.number(),
                  }),
                )
                .nullish(),
              timeseries: z
                .object({
                  tnt: z.array(timeseriesPoint).nullish(),
                  tempBedC: z.array(timeseriesPoint).nullish(),
                  tempRoomC: z.array(timeseriesPoint).nullish(),
                  respiratoryRate: z.array(timeseriesPoint).nullish(),
                  heartRate: z.array(timeseriesPoint).nullish(),
                })
                .nullish(),
            })
            .catchall(z.unknown()),
        )
        .nullish(),
    })
    .nullish(),
});

export interface NightTrend {
  date: string;
  score: number | null;
  sleepDurationHours: number | null;
  hrv: number | null;
  restingHeartRate: number | null;
  respiratoryRate: number | null;
}

export interface ThirdsBreakdown {
  firstThird: number | null;
  middleThird: number | null;
  finalThird: number | null;
}

export interface SessionDetail {
  date: string;
  score: number | null;
  stageHours: Record<string, number>;
  tossesAndTurns: ThirdsBreakdown;
  avgBedTempC: ThirdsBreakdown;
  avgRoomTempC: number | null;
  avgHeartRate: number | null;
}

export interface SleepContext {
  nights: NightTrend[];
  recentSessions: SessionDetail[];
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return round1(values.reduce((sum, v) => sum + v, 0) / values.length);
}

// Splits a timeseries into thirds of the night by timestamp span and reduces
// each third with the given aggregator (sum for event counts, mean for levels).
function byThirds(
  series: [string, number][] | null | undefined,
  mode: "sum" | "mean",
): ThirdsBreakdown {
  const empty: ThirdsBreakdown = {
    firstThird: null,
    middleThird: null,
    finalThird: null,
  };
  if (!series || series.length === 0) return empty;

  const times = series
    .map(([ts, value]) => [new Date(ts).getTime(), value] as const)
    .filter(([t]) => !isNaN(t))
    .sort((a, b) => a[0] - b[0]);
  if (times.length === 0) return empty;

  const start = times[0]![0];
  const end = times[times.length - 1]![0];
  const span = Math.max(end - start, 1);
  const buckets: number[][] = [[], [], []];
  for (const [t, value] of times) {
    const idx = Math.min(Math.floor(((t - start) / span) * 3), 2);
    buckets[idx]!.push(value);
  }

  const reduce = (values: number[]): number | null => {
    if (values.length === 0) return null;
    if (mode === "sum") return round1(values.reduce((sum, v) => sum + v, 0));
    return average(values);
  };

  return {
    firstThird: reduce(buckets[0]!),
    middleThird: reduce(buckets[1]!),
    finalThird: reduce(buckets[2]!),
  };
}

function formatDateInTimezone(date: Date, timezone: string): string {
  return date.toLocaleDateString("en-CA", { timeZone: timezone });
}

export async function collectSleepContext(
  token: Token,
  userId: string,
  timezone: string,
): Promise<SleepContext> {
  const context: SleepContext = { nights: [], recentSessions: [] };

  try {
    const to = formatDateInTimezone(new Date(), timezone);
    const from = formatDateInTimezone(
      new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
      timezone,
    );
    const params = new URLSearchParams({
      tz: timezone,
      from,
      to,
      "include-main": "false",
      "include-all-sessions": "false",
      "model-version": "v2",
    });
    const data = await fetchWithAuth(
      `${CLIENT_API_URL}/users/${userId}/trends?${params.toString()}`,
      token,
      ForgivingTrendsSchema,
    );
    for (const day of data.result?.days ?? []) {
      context.nights.push({
        date: day.day,
        score: day.score ?? null,
        sleepDurationHours:
          day.sleepDuration != null ? round1(day.sleepDuration / 3600) : null,
        hrv: day.sleepQualityScore?.hrv?.current ?? null,
        restingHeartRate: day.sleepRoutineScore?.heartRate?.current ?? null,
        respiratoryRate: day.sleepQualityScore?.respiratoryRate?.current ?? null,
      });
    }
  } catch (error) {
    console.error(
      "AI sleep context: trends fetch failed:",
      error instanceof Error ? error.message : String(error),
    );
  }

  try {
    const data = await fetchWithAuth(
      `${CLIENT_API_URL}/users/${userId}/intervals`,
      token,
      ForgivingIntervalsSchema,
    );
    const intervals = (data.result?.intervals ?? [])
      .filter((interval) => interval.ts && !interval.incomplete)
      .slice(0, 3);
    for (const interval of intervals) {
      const stageHours: Record<string, number> = {};
      for (const { stage, duration } of interval.stages ?? []) {
        stageHours[stage] = round1((stageHours[stage] ?? 0) + duration / 3600);
      }
      const heartRates = (interval.timeseries?.heartRate ?? []).map(
        ([, value]) => value,
      );
      const roomTemps = (interval.timeseries?.tempRoomC ?? []).map(
        ([, value]) => value,
      );
      context.recentSessions.push({
        date: formatDateInTimezone(new Date(interval.ts!), timezone),
        score: interval.score ?? null,
        stageHours,
        tossesAndTurns: byThirds(interval.timeseries?.tnt, "sum"),
        avgBedTempC: byThirds(interval.timeseries?.tempBedC, "mean"),
        avgRoomTempC: average(roomTemps),
        avgHeartRate: average(heartRates),
      });
    }
  } catch (error) {
    console.error(
      "AI sleep context: intervals fetch failed:",
      error instanceof Error ? error.message : String(error),
    );
  }

  return context;
}

export function hasSleepData(context: SleepContext): boolean {
  return context.nights.length > 0 || context.recentSessions.length > 0;
}

export interface LiveSessionWindow {
  recentTosses: number;
  recentAvgHeartRate: number | null;
  nightAvgHeartRate: number | null;
  recentAvgBedTempC: number | null;
}

// Reads the in-progress (incomplete) session and summarizes the last
// `windowMinutes` of it for the live tuner. Returns null when no session is
// currently running or it carries no timeseries yet.
export async function fetchCurrentSessionWindow(
  token: Token,
  userId: string,
  windowMinutes = 45,
): Promise<LiveSessionWindow | null> {
  const data = await fetchWithAuth(
    `${CLIENT_API_URL}/users/${userId}/intervals`,
    token,
    ForgivingIntervalsSchema,
  );
  const nowMs = Date.now();
  const current = (data.result?.intervals ?? []).find(
    (interval) =>
      interval.incomplete === true &&
      interval.ts &&
      nowMs - new Date(interval.ts).getTime() < 16 * 60 * 60 * 1000,
  );
  if (!current?.timeseries) return null;

  const cutoff = nowMs - windowMinutes * 60 * 1000;
  const inWindow = (point: [string, number]) =>
    new Date(point[0]).getTime() >= cutoff;

  const tnt = current.timeseries.tnt ?? [];
  const heartRate = current.timeseries.heartRate ?? [];
  const bedTemp = current.timeseries.tempBedC ?? [];

  return {
    recentTosses: tnt.filter(inWindow).reduce((sum, [, v]) => sum + v, 0),
    recentAvgHeartRate: average(
      heartRate.filter(inWindow).map(([, v]) => v),
    ),
    nightAvgHeartRate: average(heartRate.map(([, v]) => v)),
    recentAvgBedTempC: average(bedTemp.filter(inWindow).map(([, v]) => v)),
  };
}
