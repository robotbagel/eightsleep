// sleepData.ts
// Collects recent sleep metrics from the Eight Sleep API and compresses them
// into a compact context object for the AI advisor.
//
// Everything comes from ONE endpoint: /users/{id}/trends with
// include-all-sessions=true. The response carries `days` at the TOP level
// (no `result` wrapper — verified against the live API and the pyEight /
// eightctl clients), each day carrying score, per-stage durations, and
// `sessions` with the raw timeseries (tosses, bed/room temp, heart rate).
//
// Schemas are intentionally forgiving: fields are omitted freely depending
// on account/firmware/data availability. Anything missing becomes null and
// is simply absent from the AI context.
//
// NOTE: accounts without an Eight Sleep subscription (sleepTracking never
// enabled, no "tracking" feature) get an empty `days` array — the endpoint
// works, the cloud just doesn't process sessions for them.
import { z } from "zod";
import { fetchWithAuth } from "../eight/eight";
import { CLIENT_API_URL } from "../eight/constants";
import { type Token } from "../eight/types";
import { getHealthContext } from "./health";

const timeseriesPoint = z.tuple([z.string(), z.number()]);

const ForgivingSessionSchema = z
  .object({
    id: z.string().nullish(),
    ts: z.string().nullish(),
    incomplete: z.boolean().nullish(),
    score: z.number().nullish(),
    stages: z
      .array(z.object({ stage: z.string(), duration: z.number() }))
      .nullish(),
    timeseries: z
      .object({
        tnt: z.array(timeseriesPoint).nullish(),
        tempBedC: z.array(timeseriesPoint).nullish(),
        tempRoomC: z.array(timeseriesPoint).nullish(),
        respiratoryRate: z.array(timeseriesPoint).nullish(),
        heartRate: z.array(timeseriesPoint).nullish(),
      })
      .catchall(z.unknown())
      .nullish(),
  })
  .catchall(z.unknown());

const ForgivingDaySchema = z
  .object({
    day: z.string(),
    score: z.number().nullish(),
    sleepDuration: z.number().nullish(),
    presenceDuration: z.number().nullish(),
    lightDuration: z.number().nullish(),
    deepDuration: z.number().nullish(),
    remDuration: z.number().nullish(),
    presenceStart: z.string().nullish(),
    presenceEnd: z.string().nullish(),
    sleepQualityScore: z
      .object({
        total: z.number().nullish(),
        hrv: z.object({ current: z.number().nullish() }).nullish(),
        respiratoryRate: z.object({ current: z.number().nullish() }).nullish(),
      })
      .catchall(z.unknown())
      .nullish(),
    sleepRoutineScore: z
      .object({
        total: z.number().nullish(),
        heartRate: z.object({ current: z.number().nullish() }).nullish(),
      })
      .catchall(z.unknown())
      .nullish(),
    sessions: z.array(ForgivingSessionSchema).nullish(),
  })
  .catchall(z.unknown());

// Accepts both the real top-level shape and a legacy `result` wrapper.
const ForgivingTrendsSchema = z
  .object({
    days: z.array(ForgivingDaySchema).nullish(),
    result: z
      .object({ days: z.array(ForgivingDaySchema).nullish() })
      .nullish(),
  })
  .catchall(z.unknown());

type TrendDay = z.infer<typeof ForgivingDaySchema>;

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

async function fetchTrendDays(
  token: Token,
  userId: string,
  timezone: string,
  fromDaysAgo: number,
): Promise<TrendDay[]> {
  const to = formatDateInTimezone(
    new Date(Date.now() + 24 * 60 * 60 * 1000),
    timezone,
  );
  const from = formatDateInTimezone(
    new Date(Date.now() - fromDaysAgo * 24 * 60 * 60 * 1000),
    timezone,
  );
  const params = new URLSearchParams({
    tz: timezone,
    from,
    to,
    "include-main": "false",
    "include-all-sessions": "true",
    "model-version": "v2",
  });
  const data = await fetchWithAuth(
    `${CLIENT_API_URL}/users/${userId}/trends?${params.toString()}`,
    token,
    ForgivingTrendsSchema,
  );
  return data.days ?? data.result?.days ?? [];
}

function buildSessionDetail(
  day: TrendDay,
  session: z.infer<typeof ForgivingSessionSchema> | undefined,
): SessionDetail {
  const stageHours: Record<string, number> = {};
  const dayStages: [string, number | null | undefined][] = [
    ["light", day.lightDuration],
    ["deep", day.deepDuration],
    ["rem", day.remDuration],
  ];
  for (const [stage, seconds] of dayStages) {
    if (seconds != null) stageHours[stage] = round1(seconds / 3600);
  }
  if (day.presenceDuration != null && day.sleepDuration != null) {
    stageHours.awake = round1(
      Math.max(day.presenceDuration - day.sleepDuration, 0) / 3600,
    );
  }
  // Fall back to session-level stage segments when day-level durations are
  // absent.
  if (Object.keys(stageHours).length === 0 && session?.stages) {
    for (const { stage, duration } of session.stages) {
      stageHours[stage] = round1((stageHours[stage] ?? 0) + duration / 3600);
    }
  }

  const heartRates = (session?.timeseries?.heartRate ?? []).map(([, v]) => v);
  const roomTemps = (session?.timeseries?.tempRoomC ?? []).map(([, v]) => v);

  return {
    date: day.day,
    score: day.score ?? session?.score ?? null,
    stageHours,
    tossesAndTurns: byThirds(session?.timeseries?.tnt, "sum"),
    avgBedTempC: byThirds(session?.timeseries?.tempBedC, "mean"),
    avgRoomTempC: average(roomTemps),
    avgHeartRate: average(heartRates),
  };
}

export async function collectSleepContext(
  token: Token,
  userId: string,
  timezone: string,
  email?: string,
): Promise<SleepContext> {
  const context: SleepContext = { nights: [], recentSessions: [] };

  let days: TrendDay[] = [];
  try {
    days = await fetchTrendDays(token, userId, timezone, 7);
  } catch (error) {
    console.error(
      "AI sleep context: trends fetch failed:",
      error instanceof Error ? error.message : String(error),
    );
  }

  for (const day of days) {
    if (day.score == null && day.sleepDuration == null) continue;
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

  // Per-session detail for the most recent days that have a completed
  // session (newest first).
  const daysWithSessions = days
    .filter((day) =>
      (day.sessions ?? []).some((session) => session.incomplete !== true),
    )
    .slice(-3)
    .reverse();
  for (const day of daysWithSessions) {
    const completed = (day.sessions ?? []).filter(
      (session) => session.incomplete !== true,
    );
    context.recentSessions.push(
      buildSessionDetail(day, completed[completed.length - 1]),
    );
  }

  // Merge in Apple Health nights (imported via the Shortcut endpoint). Pod
  // data wins per date; the watch fills the gaps — or carries the whole
  // context for accounts whose pod data is subscription-gated.
  if (email) {
    try {
      const health = await getHealthContext(email);
      const podNightDates = new Set(context.nights.map((n) => n.date));
      for (const night of health.nights) {
        if (!podNightDates.has(night.date)) context.nights.push(night);
      }
      context.nights.sort((a, b) => a.date.localeCompare(b.date));

      const podSessionDates = new Set(
        context.recentSessions.map((s) => s.date),
      );
      for (const session of health.recentSessions) {
        if (!podSessionDates.has(session.date)) {
          context.recentSessions.push(session);
        }
      }
      context.recentSessions.sort((a, b) => b.date.localeCompare(a.date));
      context.recentSessions = context.recentSessions.slice(0, 3);
    } catch (error) {
      console.error(
        "AI sleep context: health merge failed:",
        error instanceof Error ? error.message : String(error),
      );
    }
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

// Reads the in-progress (incomplete) session from today's trends and
// summarizes the last `windowMinutes` of it for the live tuner. Returns null
// when no session is currently running or it carries no timeseries yet.
export async function fetchCurrentSessionWindow(
  token: Token,
  userId: string,
  timezone: string,
  windowMinutes = 45,
): Promise<LiveSessionWindow | null> {
  const days = await fetchTrendDays(token, userId, timezone, 1);
  const nowMs = Date.now();

  let current: z.infer<typeof ForgivingSessionSchema> | null = null;
  for (const day of days) {
    for (const session of day.sessions ?? []) {
      const tsMs = session.ts ? new Date(session.ts).getTime() : NaN;
      if (
        session.incomplete === true &&
        (isNaN(tsMs) || nowMs - tsMs < 16 * 60 * 60 * 1000)
      ) {
        current = session;
      }
    }
  }
  if (!current?.timeseries) return null;

  const cutoff = nowMs - windowMinutes * 60 * 1000;
  const inWindow = (point: [string, number]) =>
    new Date(point[0]).getTime() >= cutoff;

  const tnt = current.timeseries.tnt ?? [];
  const heartRate = current.timeseries.heartRate ?? [];
  const bedTemp = current.timeseries.tempBedC ?? [];

  return {
    recentTosses: tnt.filter(inWindow).reduce((sum, [, v]) => sum + v, 0),
    recentAvgHeartRate: average(heartRate.filter(inWindow).map(([, v]) => v)),
    nightAvgHeartRate: average(heartRate.map(([, v]) => v)),
    recentAvgBedTempC: average(bedTemp.filter(inWindow).map(([, v]) => v)),
  };
}
