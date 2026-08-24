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
import { APP_API_URL, CLIENT_API_URL } from "../eight/constants";
import { type Token } from "../eight/types";
import { getHealthContext } from "./health";
import {
  circularMeanMinutes,
  minutesOfDayInZone,
  scoreNight,
} from "./score";

// ---------------------------------------------------------------------------
// Pod sessions (app-api /v1/users/{id}/sessions)
//
// This endpoint is NOT subscription-gated (unlike /trends and /intervals,
// which return empty arrays without an Autopilot membership) and carries the
// pod's own raw measurements: full hypnogram, toss-and-turn timestamps, bed
// and room temperature, heart rate, HRV/RMSSD, respiratory rate and short
// awakenings. Only `score` is withheld (always 0), so we compute our own.
// ---------------------------------------------------------------------------

const series = z.array(z.tuple([z.string(), z.number()])).nullish();

const PodSessionSchema = z
  .object({
    id: z.string().nullish(),
    ts: z.string().nullish(),
    deviceTimeAtUpdate: z.string().nullish(),
    sleepStart: z.string().nullish(),
    sleepEnd: z.string().nullish(),
    presenceEnd: z.string().nullish(),
    duration: z.number().nullish(),
    incomplete: z.boolean().nullish(),
    timezone: z.string().nullish(),
    // The hypnogram: consecutive stage runs starting at `ts`, durations in
    // seconds. This is what makes a real stage chart possible.
    stages: z
      .array(
        z
          .object({ stage: z.string(), duration: z.number() })
          .catchall(z.unknown()),
      )
      .nullish(),
    stageSummary: z
      .object({
        totalDuration: z.number().nullish(),
        sleepDuration: z.number().nullish(),
        awakeDuration: z.number().nullish(),
        lightDuration: z.number().nullish(),
        deepDuration: z.number().nullish(),
        remDuration: z.number().nullish(),
        outDuration: z.number().nullish(),
      })
      .catchall(z.unknown())
      .nullish(),
    timeseries: z
      .object({
        tnt: series,
        tempRoomC: series,
        tempBedC: series,
        heartRate: series,
        hrv: series,
        rmssd: series,
        respiratoryRate: series,
        nemeanRespiratoryRate: series,
        shortAwakes: series,
        heating: series,
      })
      .catchall(z.unknown())
      .nullish(),
  })
  .catchall(z.unknown());

const PodSessionsSchema = z
  .object({
    sessions: z.array(PodSessionSchema).nullish(),
    next: z.string().nullish(),
  })
  .catchall(z.unknown());

export type PodSession = z.infer<typeof PodSessionSchema>;

/**
 * The sessions endpoint always returns the newest ~10 sessions and ignores
 * `limit`, `size`, `from` and `to`. The ONLY parameter that pages backwards
 * is `?next=<cursor>`, using the opaque `next` token from the previous page
 * (verified live, 2026-08-24). `pages` therefore controls how far back the
 * history reaches, roughly 10 nights per page.
 */
export async function fetchPodSessions(
  token: Token,
  userId: string,
  pages = 1,
): Promise<PodSession[]> {
  const all: PodSession[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < Math.max(1, pages); page++) {
    const url =
      `${APP_API_URL}v1/users/${userId}/sessions` +
      (cursor ? `?next=${encodeURIComponent(cursor)}` : "");
    const data: z.infer<typeof PodSessionsSchema> = await fetchWithAuth(
      url,
      token,
      PodSessionsSchema,
    );
    const batch = data.sessions ?? [];
    all.push(...batch);
    cursor = data.next ?? null;
    // No cursor, or a page the API did not fill, means we reached the end.
    if (!cursor || batch.length === 0) break;
  }

  // The same session can appear on two pages if a night rolls over between
  // requests; keep one row per id (falling back to the timestamp).
  const seen = new Set<string>();
  return all.filter((session) => {
    const key = session.id ?? session.ts ?? JSON.stringify(session.sleepEnd);
    if (typeof key !== "string" || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

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

// Builds nights + per-session detail from the pod's own session records.
export function buildContextFromPodSessions(
  sessions: PodSession[],
  timezone: string,
  limitNights = 7,
): SleepContext {
  const context: SleepContext = { nights: [], recentSessions: [] };

  const usable = sessions
    .filter((s) => (s.stageSummary?.sleepDuration ?? 0) > 0 && s.sleepEnd)
    .sort((a, b) => (a.sleepEnd! < b.sleepEnd! ? -1 : 1))
    .slice(-limitNights);
  if (usable.length === 0) return context;

  // Reference bedtime = circular mean of these nights' sleep starts.
  const bedtimes = usable
    .map((s) => (s.sleepStart ? new Date(s.sleepStart) : null))
    .filter((d): d is Date => d != null && !isNaN(d.getTime()))
    .map((d) => minutesOfDayInZone(d, timezone));
  const referenceBedtime = circularMeanMinutes(bedtimes);

  for (const session of usable) {
    const summary = session.stageSummary ?? {};
    const asleepHours = (summary.sleepDuration ?? 0) / 3600;
    const awakeHours = (summary.awakeDuration ?? 0) / 3600;
    const shortAwakes = session.timeseries?.shortAwakes ?? [];
    const wakeCount = shortAwakes.length > 0 ? shortAwakes.length : null;
    const startDate = session.sleepStart ? new Date(session.sleepStart) : null;
    const bedtimeMinutes =
      startDate && !isNaN(startDate.getTime())
        ? minutesOfDayInZone(startDate, timezone)
        : null;

    const date = new Date(session.sleepEnd!).toLocaleDateString("en-CA", {
      timeZone: timezone,
    });
    const hrvSeries = session.timeseries?.rmssd ?? session.timeseries?.hrv ?? [];
    const heartRates = (session.timeseries?.heartRate ?? []).map(([, v]) => v);
    const respiratory = (
      session.timeseries?.respiratoryRate ??
      session.timeseries?.nemeanRespiratoryRate ??
      []
    ).map(([, v]) => v);

    context.nights.push({
      date,
      score: scoreNight({
        asleepHours,
        awakeHours,
        wakeCount,
        bedtimeMinutes,
        referenceBedtimeMinutes: referenceBedtime,
      }),
      sleepDurationHours: round1(asleepHours),
      hrv: average(hrvSeries.map(([, v]) => v)),
      restingHeartRate:
        heartRates.length > 0 ? round1(Math.min(...heartRates)) : null,
      respiratoryRate: average(respiratory),
    });
  }

  // Per-session detail (newest first) for the three most recent nights.
  for (const session of usable.slice(-3).reverse()) {
    const summary = session.stageSummary ?? {};
    const date = new Date(session.sleepEnd!).toLocaleDateString("en-CA", {
      timeZone: timezone,
    });
    const stageHours: Record<string, number> = {};
    const stageMap: [string, number | null | undefined][] = [
      ["deep", summary.deepDuration],
      ["rem", summary.remDuration],
      ["light", summary.lightDuration],
      ["awake", summary.awakeDuration],
    ];
    for (const [stage, seconds] of stageMap) {
      if (seconds != null) stageHours[stage] = round1(seconds / 3600);
    }
    const night = context.nights.find((n) => n.date === date);
    const heartRates = (session.timeseries?.heartRate ?? []).map(([, v]) => v);

    context.recentSessions.push({
      date,
      score: night?.score ?? null,
      stageHours,
      tossesAndTurns: byThirds(session.timeseries?.tnt, "sum"),
      avgBedTempC: byThirds(session.timeseries?.tempBedC, "mean"),
      avgRoomTempC: average(
        (session.timeseries?.tempRoomC ?? []).map(([, v]) => v),
      ),
      avgHeartRate: average(heartRates),
    });
  }

  return context;
}

export async function collectSleepContext(
  token: Token,
  userId: string,
  timezone: string,
  email?: string,
): Promise<SleepContext> {
  let context: SleepContext = { nights: [], recentSessions: [] };

  // Primary source: the pod's own session records (works without a
  // subscription and carries tosses, bed temp, HR, HRV and breathing).
  try {
    const sessions = await fetchPodSessions(token, userId);
    context = buildContextFromPodSessions(sessions, timezone);
  } catch (error) {
    console.error(
      "AI sleep context: pod sessions fetch failed:",
      error instanceof Error ? error.message : String(error),
    );
  }

  let days: TrendDay[] = [];
  if (context.nights.length === 0) {
    // Fall back to trends (populated only for subscribed accounts).
    try {
      days = await fetchTrendDays(token, userId, timezone, 7);
    } catch (error) {
      console.error(
        "AI sleep context: trends fetch failed:",
        error instanceof Error ? error.message : String(error),
      );
    }
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

// Reads the in-progress session from the pod and summarizes the last
// `windowMinutes` for the live tuner. Returns null when no session is
// currently running (or its data is stale, i.e. the night already ended).
export async function fetchCurrentSessionWindow(
  token: Token,
  userId: string,
  _timezone: string,
  windowMinutes = 45,
): Promise<LiveSessionWindow | null> {
  const sessions = await fetchPodSessions(token, userId);
  if (sessions.length === 0) return null;

  // Newest session by update time.
  const current = sessions
    .slice()
    .sort((a, b) =>
      (a.deviceTimeAtUpdate ?? a.ts ?? "") < (b.deviceTimeAtUpdate ?? b.ts ?? "")
        ? -1
        : 1,
    )
    .pop();
  if (!current?.timeseries) return null;

  const nowMs = Date.now();
  const heartRate: [string, number][] = current.timeseries.heartRate ?? [];
  const bedTemp: [string, number][] = current.timeseries.tempBedC ?? [];
  const tnt: [string, number][] = current.timeseries.tnt ?? [];

  // Freshness gate: the newest sample must be recent, otherwise this is a
  // finished night and there is nothing live to tune.
  const sampleTimes: number[] = [];
  const groups: [string, number][][] = [heartRate, bedTemp, tnt];
  for (const group of groups) {
    for (const point of group) {
      sampleTimes.push(new Date(point[0]).getTime());
    }
  }
  if (current.deviceTimeAtUpdate) {
    sampleTimes.push(new Date(current.deviceTimeAtUpdate).getTime());
  }
  const newestSample = sampleTimes.length > 0 ? Math.max(...sampleTimes) : NaN;
  if (!isFinite(newestSample) || nowMs - newestSample > 90 * 60 * 1000) {
    return null;
  }

  const cutoff = nowMs - windowMinutes * 60 * 1000;
  const inWindow = (point: [string, number]) =>
    new Date(point[0]).getTime() >= cutoff;

  return {
    recentTosses: tnt.filter(inWindow).reduce((sum, [, v]) => sum + v, 0),
    recentAvgHeartRate: average(heartRate.filter(inWindow).map(([, v]) => v)),
    nightAvgHeartRate: average(heartRate.map(([, v]) => v)),
    recentAvgBedTempC: average(bedTemp.filter(inWindow).map(([, v]) => v)),
  };
}
