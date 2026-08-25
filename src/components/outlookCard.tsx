"use client";
import React from "react";
import { apiR, type RouterOutputs } from "~/trpc/react";
import { Card, CardHeader, Skeleton } from "./ui/card";
import { formatHours } from "./charts/chartUtils";

type Outlook = RouterOutputs["user"]["getNightOutlook"];

export const OutlookCard: React.FC<{ index?: number }> = ({ index = 0 }) => {
  const query = apiR.user.getNightOutlook.useQuery(undefined, {
    retry: 1,
    refetchOnWindowFocus: false,
  });
  return (
    <OutlookView
      index={index}
      data={query.data ?? null}
      loading={query.isLoading}
    />
  );
};

export const OutlookView: React.FC<{
  index?: number;
  data: Outlook | null;
  loading: boolean;
}> = ({ index = 0, data, loading }) => {
  if (loading) {
    return (
      <Card index={index}>
        <CardHeader icon="sleep" title="How you're sleeping" />
        <div className="grid grid-cols-3 gap-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-44" />
          ))}
        </div>
      </Card>
    );
  }

  if (!data || (!data.lastNight && !data.nightBefore)) {
    return (
      <Card index={index}>
        <CardHeader icon="sleep" title="How you're sleeping" />
        <p className="text-sm" style={{ color: "var(--text-muted)" }}>
          Two recorded nights are enough to start showing the trend. Sleep on
          the pod tonight and this fills itself in by morning.
        </p>
      </Card>
    );
  }

  const forecast = data.tonight.forecast;
  const forecastMid = forecast
    ? Math.round((forecast.expectedScoreLow + forecast.expectedScoreHigh) / 2)
    : null;

  return (
    <Card index={index}>
      <CardHeader
        icon="sleep"
        title="How you're sleeping"
        subtitle="The night before last, last night, and what tonight should come out at."
      />

      {/* One row per measurement, three columns of nights. Three stat
          COLUMNS looked fine on a desktop and fell apart at 390px, where
          each cell had to hold a label, a value and a delta side by side. */}
      <div
        className="grid gap-x-2 gap-y-1"
        style={{ gridTemplateColumns: "auto repeat(3, minmax(0, 1fr))" }}
      >
        <span />
        <ColumnHead title="2 nights ago" night={data.nightBefore?.night} />
        <ColumnHead title="Last night" night={data.lastNight?.night} emphasis />
        <ColumnHead
          title="Tonight"
          night={data.tonight.night}
          accent
          note={data.tonight.planned ? "expected" : "not planned"}
        />

        <MetricRow
          label="Score"
          big
          cells={[
            { value: fmtScore(data.nightBefore?.score) },
            {
              value: fmtScore(data.lastNight?.score),
              delta: delta(data.lastNight?.score, data.nightBefore?.score, (v) =>
                Math.round(v).toString(),
              ),
              emphasis: true,
            },
            {
              value: forecastMid == null ? "—" : String(forecastMid),
              sub: forecast
                ? `${forecast.expectedScoreLow}–${forecast.expectedScoreHigh}`
                : undefined,
              predicted: true,
            },
          ]}
        />

        <MetricRow
          label="Asleep"
          cells={[
            { value: formatHours(data.nightBefore?.asleepHours) },
            {
              value: formatHours(data.lastNight?.asleepHours),
              delta: delta(
                data.lastNight?.asleepHours,
                data.nightBefore?.asleepHours,
                (v) => `${Math.round(v * 60)}m`,
              ),
              emphasis: true,
            },
            { value: "—", predicted: true },
          ]}
        />

        <MetricRow
          label="Deep"
          cells={[
            { value: formatHours(data.nightBefore?.deepHours) },
            {
              value: formatHours(data.lastNight?.deepHours),
              delta: delta(
                data.lastNight?.deepHours,
                data.nightBefore?.deepHours,
                (v) => `${Math.round(v * 60)}m`,
              ),
              emphasis: true,
            },
            {
              value:
                forecast?.expectedDeepHours == null
                  ? "—"
                  : formatHours(forecast.expectedDeepHours),
              delta: delta(
                forecast?.expectedDeepHours,
                data.lastNight?.deepHours,
                (v) => `${Math.round(v * 60)}m`,
              ),
              predicted: true,
            },
          ]}
        />

        <MetricRow
          label="Tosses"
          cells={[
            { value: fmtCount(data.nightBefore?.tosses) },
            {
              value: fmtCount(data.lastNight?.tosses),
              delta: delta(
                data.lastNight?.tosses,
                data.nightBefore?.tosses,
                (v) => String(Math.round(v)),
                false,
              ),
              emphasis: true,
            },
            {
              value: fmtCount(
                forecast?.expectedTosses == null
                  ? null
                  : Math.round(forecast.expectedTosses),
              ),
              delta: delta(
                forecast?.expectedTosses,
                data.lastNight?.tosses,
                (v) => String(Math.round(v)),
                false,
              ),
              predicted: true,
            },
          ]}
        />
      </div>

      {data.tonight.expectation && (
        <p
          className="mt-4 rounded-xl p-3 text-sm leading-relaxed"
          style={{ backgroundColor: "var(--cool-soft)", color: "var(--text)" }}
        >
          <span className="font-semibold">Tonight: </span>
          {data.tonight.expectation}
        </p>
      )}

      {data.accuracy && (
        <p
          className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs"
          style={{ color: "var(--text-muted)" }}
        >
          <span
            className="chip"
            style={{
              color: data.accuracy.hit ? "var(--success)" : "var(--warning)",
              backgroundColor: data.accuracy.hit
                ? "var(--success-soft)"
                : "var(--warning-soft)",
            }}
          >
            {data.accuracy.hit ? "Called it" : "Missed"}
          </span>
          <span className="tabular">
            Last night was predicted at {data.accuracy.low}–{data.accuracy.high}
            {" and came out at "}
            {data.accuracy.actual}.
          </span>
        </p>
      )}

      {!data.tonight.planned && (
        <p className="mt-3 text-xs" style={{ color: "var(--text-faint)" }}>
          Tonight has no plan yet, so there is nothing to predict from. It is
          decided about half an hour after you wake.
        </p>
      )}
    </Card>
  );
};

const fmtScore = (value: number | null | undefined) =>
  value == null ? "—" : String(Math.round(value));
const fmtCount = (value: number | null | undefined) =>
  value == null ? "—" : String(Math.round(value));

interface Delta {
  text: string;
  better: boolean;
}

function delta(
  current: number | null | undefined,
  previous: number | null | undefined,
  format: (value: number) => string,
  higherIsBetter = true,
): Delta | undefined {
  if (current == null || previous == null) return undefined;
  const diff = current - previous;
  if (Math.abs(diff) < 0.005) return undefined;
  return {
    text: `${diff > 0 ? "+" : "−"}${format(Math.abs(diff))}`,
    better: higherIsBetter ? diff > 0 : diff < 0,
  };
}

const ColumnHead: React.FC<{
  title: string;
  night?: string;
  accent?: boolean;
  emphasis?: boolean;
  note?: string;
}> = ({ title, night, accent, note }) => (
  <span className="pb-1 text-center">
    <span
      className="block text-[9px] font-semibold uppercase leading-tight tracking-wide"
      style={{ color: accent ? "var(--accent)" : "var(--text-faint)" }}
    >
      {title}
    </span>
    <span
      className="tabular block text-[10px] leading-tight"
      style={{ color: "var(--text-faint)" }}
    >
      {note ??
        (night
          ? new Date(`${night}T12:00:00Z`).toLocaleDateString("en-GB", {
              day: "numeric",
              month: "short",
            })
          : "no record")}
    </span>
  </span>
);

interface CellSpec {
  value: string;
  sub?: string;
  delta?: Delta;
  emphasis?: boolean;
  /** Tonight is a prediction and is never drawn like measured data. */
  predicted?: boolean;
}

const MetricRow: React.FC<{
  label: string;
  cells: CellSpec[];
  big?: boolean;
}> = ({ label, cells, big }) => (
  <>
    <span
      className="self-center pr-1 text-[11px]"
      style={{ color: "var(--text-muted)" }}
    >
      {label}
    </span>
    {cells.map((cell, index) => (
      <span
        key={index}
        className="rounded-lg px-1 py-1.5 text-center"
        style={{
          backgroundColor: cell.emphasis ? "var(--surface-sunken)" : undefined,
          border: cell.predicted ? "1px dashed var(--border-strong)" : undefined,
        }}
      >
        <span
          className="tabular block font-semibold leading-tight"
          style={{
            fontSize: big ? "1.35rem" : "0.8125rem",
            color: cell.predicted
              ? "var(--accent)"
              : "var(--text-headline)",
          }}
        >
          {cell.value}
        </span>
        {cell.sub && (
          <span
            className="tabular block text-[10px] leading-tight"
            style={{ color: "var(--text-faint)" }}
          >
            {cell.sub}
          </span>
        )}
        {cell.delta && (
          <span
            className="tabular block text-[10px] font-semibold leading-tight"
            style={{
              color: cell.delta.better ? "var(--success)" : "var(--danger)",
            }}
          >
            {cell.delta.text}
          </span>
        )}
      </span>
    ))}
  </>
);
