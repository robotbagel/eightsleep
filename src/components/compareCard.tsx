"use client";
import React, { useState } from "react";
import { apiR, type RouterOutputs } from "~/trpc/react";
import { Card, CardHeader, Skeleton } from "./ui/card";
import { Sparkline } from "./charts/sparkline";
import { formatHours, scoreTone, TONE_VAR, type Point } from "./charts/chartUtils";

type Days = 7 | 14 | 30;

type MetricKey =
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

interface MetricMeta {
  key: MetricKey;
  label: string;
  color: string;
  /** Neutral metrics get no better/worse verdict, only the direction. */
  neutral?: boolean;
  higherIsBetter?: boolean;
  format: (value: number) => string;
  /** Deltas sometimes need different units from the value (a bedtime shift
   *  is "+40m", not "+00:40"). Falls back to `format`. */
  deltaFormat?: (value: number) => string;
}

function clockOf(minutes: number): string {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

const METRICS: MetricMeta[] = [
  {
    key: "asleepHours",
    label: "Time asleep",
    color: "var(--accent)",
    higherIsBetter: true,
    format: formatHours,
  },
  {
    key: "deepHours",
    label: "Deep sleep",
    color: "var(--stage-deep)",
    higherIsBetter: true,
    format: formatHours,
  },
  {
    key: "remHours",
    label: "REM sleep",
    color: "var(--stage-rem)",
    higherIsBetter: true,
    format: formatHours,
  },
  {
    key: "awakeHours",
    label: "Awake in bed",
    color: "var(--stage-awake)",
    higherIsBetter: false,
    format: formatHours,
  },
  {
    key: "tosses",
    label: "Tosses",
    color: "var(--stage-awake)",
    higherIsBetter: false,
    format: (v) => Math.round(v).toString(),
  },
  {
    key: "restingHeartRate",
    label: "Resting HR",
    color: "var(--danger)",
    higherIsBetter: false,
    format: (v) => `${Math.round(v)} bpm`,
  },
  {
    key: "hrv",
    label: "HRV",
    color: "var(--accent)",
    higherIsBetter: true,
    format: (v) => `${Math.round(v)} ms`,
  },
  {
    key: "respiratoryRate",
    label: "Breathing rate",
    color: "var(--cool)",
    higherIsBetter: false,
    format: (v) => `${v.toFixed(1)} /min`,
  },
  {
    key: "avgBedTempC",
    label: "Bed temp",
    color: "var(--warm)",
    neutral: true,
    format: (v) => `${v.toFixed(1)}°C`,
  },
  {
    key: "bedtimeMinutes",
    label: "Typical bedtime",
    color: "var(--text-muted)",
    neutral: true,
    format: clockOf,
    deltaFormat: (v) => `${Math.round(v)}m`,
  },
];

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export type CompareData = RouterOutputs["user"]["getSleepHistory"];

export const CompareCard: React.FC<{ index?: number; bare?: boolean }> = ({
  index = 0,
  bare = false,
}) => {
  const [days, setDays] = useState<Days>(7);
  const query = apiR.user.getSleepHistory.useQuery(
    { days },
    { retry: 1, refetchOnWindowFocus: false, placeholderData: (prev) => prev },
  );

  return (
    <CompareView
      index={index}
      bare={bare}
      days={days}
      onDays={setDays}
      data={query.data ?? null}
      loading={query.isLoading}
      fetching={query.isFetching}
    />
  );
};

export const CompareView: React.FC<{
  index?: number;
  bare?: boolean;
  days: Days;
  onDays: (days: Days) => void;
  data: CompareData | null;
  loading: boolean;
  fetching: boolean;
}> = ({ index = 0, bare = false, days, onDays, data, loading, fetching }) => {
  const nights = data?.nights ?? [];
  const toEpoch = (night: string) => new Date(`${night}T12:00:00Z`).getTime();

  const scoreAgg = data?.aggregates.find((a) => a.key === "score");
  const scored = nights.filter((n) => n.score != null);
  const bestNight = scored.reduce<(typeof scored)[number] | null>(
    (top, n) => ((n.score ?? 0) > (top?.score ?? -1) ? n : top),
    null,
  );
  const worstNight = scored.reduce<(typeof scored)[number] | null>(
    (low, n) => ((n.score ?? 101) < (low?.score ?? 101) ? n : low),
    null,
  );

  const rangePicker = (
          <div
            className="flex overflow-hidden rounded-lg border p-0.5"
            style={{ borderColor: "var(--border-strong)" }}
            role="group"
            aria-label="Comparison range"
          >
            {([7, 14, 30] as Days[]).map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={days === option}
                onClick={() => onDays(option)}
                className="rounded-md px-2.5 py-1 text-xs font-semibold transition-colors duration-fast ease-snap"
                style={{
                  backgroundColor:
                    days === option ? "var(--accent)" : "transparent",
                  color:
                    days === option ? "var(--accent-ink)" : "var(--text-muted)",
                }}
              >
                {option}d
              </button>
            ))}
    </div>
  );


  const body = (
    <>
      {!bare && (
        <CardHeader
          icon="chart"
          title="Compare"
          subtitle={
            data
              ? `${nights.length} night${nights.length === 1 ? "" : "s"} recorded in the last ${days}`
              : undefined
          }
          right={rangePicker}
        />
      )}
      {bare && (
        <div className="mb-4 flex items-center justify-between gap-2">
          <span className="text-xs" style={{ color: "var(--text-muted)" }}>
            {data
              ? `${nights.length} night${nights.length === 1 ? "" : "s"} recorded`
              : ""}
          </span>
          {rangePicker}
        </div>
      )}

      {loading && !data ? (
        <div className="space-y-3">
          <Skeleton className="h-20" />
          <Skeleton className="h-64" />
        </div>
      ) : nights.length === 0 ? (
        <div className="py-8 text-center">
          <p className="text-sm" style={{ color: "var(--text-muted)" }}>
            No nights recorded in this window yet.
          </p>
          <button
            type="button"
            onClick={() => onDays(30)}
            className="btn btn-secondary mx-auto mt-4"
            disabled={days === 30}
          >
            Look back 30 days
          </button>
        </div>
      ) : (
        <div
          className={
            fetching
              ? "opacity-60 transition-opacity duration-fast ease-snap"
              : "transition-opacity duration-fast ease-snap"
          }
        >
          {/* Headline: the average score and how the window moved. */}
          <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
            <div>
              <div className="card-title mb-1">Average score</div>
              <div className="flex items-baseline gap-2">
                <span
                  className="tabular text-4xl font-semibold leading-none"
                  style={{
                    color: TONE_VAR[
                      scoreTone(
                        scoreAgg?.average == null
                          ? null
                          : Math.round(scoreAgg.average),
                      )
                    ],
                  }}
                >
                  {scoreAgg?.average == null
                    ? "—"
                    : Math.round(scoreAgg.average)}
                </span>
                <Delta
                  current={scoreAgg?.average ?? null}
                  previous={scoreAgg?.previousAverage ?? null}
                  higherIsBetter
                  format={(v) => Math.round(v).toString()}
                  suffix={`vs previous ${days} days`}
                />
              </div>
            </div>

            <div className="flex gap-2">
              {bestNight && (
                <Extreme
                  label="Best"
                  night={bestNight.night}
                  score={bestNight.score}
                  color="var(--success)"
                />
              )}
              {worstNight && worstNight.night !== bestNight?.night && (
                <Extreme
                  label="Worst"
                  night={worstNight.night}
                  score={worstNight.score}
                  color="var(--danger)"
                />
              )}
            </div>
          </div>

          <ScoreStrip nights={nights} />

          <div className="mt-5 grid gap-x-8 gap-y-3 sm:grid-cols-2">
            {METRICS.map((meta) => {
              const agg = data?.aggregates.find((a) => a.key === meta.key);
              const series: Point[] = nights
                .filter((n) => n[meta.key] != null)
                .map((n) => [toEpoch(n.night), n[meta.key]!] as Point);
              if (series.length === 0) return null;
              return (
                <MetricRow
                  key={meta.key}
                  meta={meta}
                  average={agg?.average ?? null}
                  previous={agg?.previousAverage ?? null}
                  best={agg?.best ?? null}
                  worst={agg?.worst ?? null}
                  series={series}
                />
              );
            })}
          </div>

          <WeekdayStrip
            values={data?.weekday.score ?? []}
            nightCount={nights.length}
          />
        </div>
      )}
    </>
  );

  return bare ? body : <Card index={index}>{body}</Card>;
};

/** Every night in the window as one bar, so the shape of the run is visible. */
const ScoreStrip: React.FC<{
  nights: { night: string; score: number | null; asleepHours: number | null }[];
}> = ({ nights }) => {
  const [active, setActive] = useState<number | null>(null);
  const hovered = active != null ? nights[active] : null;
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
          Night by night
        </span>
        <span
          className="tabular text-[11px]"
          style={{ color: "var(--text-faint)" }}
        >
          {hovered
            ? `${new Date(`${hovered.night}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short" })} · ${hovered.score ?? "—"} · ${formatHours(hovered.asleepHours)}`
            : "0–100"}
        </span>
      </div>
      <div
        className="flex h-20 items-end gap-[3px]"
        onMouseLeave={() => setActive(null)}
      >
        {nights.map((night, i) => (
          <button
            key={night.night}
            type="button"
            className="flex h-full flex-1 flex-col justify-end rounded-sm focus-visible:outline-none"
            onMouseEnter={() => setActive(i)}
            onFocus={() => setActive(i)}
            onBlur={() => setActive(null)}
            aria-label={`${night.night}: score ${night.score ?? "not available"}`}
          >
            <span
              className="grow-bar block w-full rounded-t-[3px] transition-opacity duration-fast ease-snap"
              style={
                {
                  height: `${Math.max(night.score ?? 0, 3)}%`,
                  backgroundColor: TONE_VAR[scoreTone(night.score)],
                  opacity: active == null || active === i ? 1 : 0.4,
                  "--i": Math.min(i, 14),
                } as React.CSSProperties
              }
            />
          </button>
        ))}
      </div>
    </div>
  );
};

const MetricRow: React.FC<{
  meta: MetricMeta;
  average: number | null;
  previous: number | null;
  best: number | null;
  worst: number | null;
  series: Point[];
}> = ({ meta, average, previous, best, series }) => (
  <div
    className="flex items-center gap-3 rounded-lg px-2 py-1.5 transition-colors duration-fast ease-snap hover:bg-[var(--surface-hover)]"
  >
    <div className="min-w-0 flex-1">
      <div className="truncate text-[11px]" style={{ color: "var(--text-muted)" }}>
        {meta.label}
      </div>
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span
          className="tabular text-[15px] font-semibold"
          style={{ color: "var(--text-headline)" }}
        >
          {average == null ? "—" : meta.format(average)}
        </span>
        <Delta
          current={average}
          previous={previous}
          higherIsBetter={meta.higherIsBetter ?? true}
          neutral={meta.neutral}
          format={meta.deltaFormat ?? meta.format}
          compact
        />
      </div>
      {best != null && !meta.neutral && (
        <div className="text-[10px]" style={{ color: "var(--text-faint)" }}>
          best {meta.format(best)}
        </div>
      )}
    </div>
    <div className="w-20 shrink-0 sm:w-24">
      <Sparkline series={series} color={meta.color} height={26} />
    </div>
  </div>
);

const Delta: React.FC<{
  current: number | null;
  previous: number | null;
  higherIsBetter: boolean;
  neutral?: boolean;
  format: (value: number) => string;
  suffix?: string;
  compact?: boolean;
}> = ({ current, previous, higherIsBetter, neutral, format, suffix, compact }) => {
  if (current == null || previous == null) {
    return compact ? null : (
      <span className="text-xs" style={{ color: "var(--text-faint)" }}>
        no earlier window to compare
      </span>
    );
  }
  const diff = current - previous;
  const flat = Math.abs(diff) < 0.05;
  const better = higherIsBetter ? diff > 0 : diff < 0;
  const color = neutral
    ? "var(--text-muted)"
    : flat
      ? "var(--text-faint)"
      : better
        ? "var(--success)"
        : "var(--danger)";
  // Formatters render magnitudes (durations, clock times); a delta needs its
  // own sign and, for clock-shaped values, plain minutes.
  const magnitude = flat
    ? "no change"
    : `${diff > 0 ? "+" : "−"}${format(Math.abs(diff)).replace(/^0h /, "")}`;

  return (
    <span
      className="tabular text-xs font-semibold"
      style={{ color }}
      title={`Previous window average: ${format(previous)}`}
    >
      {magnitude}
      {suffix && (
        <span className="ml-1 font-normal" style={{ color: "var(--text-faint)" }}>
          {suffix}
        </span>
      )}
    </span>
  );
};

const Extreme: React.FC<{
  label: string;
  night: string;
  score: number | null;
  color: string;
}> = ({ label, night, score, color }) => (
  <div className="tile min-w-[86px]">
    <div className="tile-label">{label}</div>
    <div className="tabular text-lg font-semibold" style={{ color }}>
      {score ?? "—"}
    </div>
    <div className="tile-sub">
      {new Date(`${night}T12:00:00Z`).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
      })}
    </div>
  </div>
);

/** Which days of the week actually sleep well — only useful with enough nights. */
const WeekdayStrip: React.FC<{
  values: (number | null)[];
  nightCount: number;
}> = ({ values, nightCount }) => {
  if (nightCount < 7 || values.every((v) => v == null)) return null;
  const present = values.filter((v): v is number => v != null);
  const max = Math.max(...present, 1);
  // Monday-first reading order.
  const order = [1, 2, 3, 4, 5, 6, 0];

  return (
    <div className="mt-5 border-t pt-4" style={{ borderColor: "var(--border)" }}>
      <div className="card-title mb-2">Average score by weekday</div>
      <div className="flex gap-1.5">
        {order.map((weekday, i) => {
          const value = values[weekday] ?? null;
          return (
            <div key={weekday} className="flex flex-1 flex-col items-center gap-1">
              <span
                className="tabular text-[10px]"
                style={{ color: "var(--text-faint)" }}
              >
                {value == null ? "—" : Math.round(value)}
              </span>
              <span className="flex h-12 w-full items-end">
                <span
                  className="grow-bar block w-full rounded-t-[3px]"
                  style={
                    {
                      height: value == null ? 3 : `${(value / max) * 100}%`,
                      minHeight: 3,
                      backgroundColor:
                        value == null
                          ? "var(--surface-sunken)"
                          : TONE_VAR[scoreTone(Math.round(value))],
                      "--i": i,
                    } as React.CSSProperties
                  }
                />
              </span>
              <span
                className="text-[10px]"
                style={{ color: "var(--text-muted)" }}
              >
                {WEEKDAYS[weekday]!.slice(0, 2)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
};
