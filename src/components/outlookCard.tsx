"use client";
import React from "react";
import { apiR, type RouterOutputs } from "~/trpc/react";
import { Card, CardHeader, Skeleton } from "./ui/card";
import { formatHours, scoreTone, TONE_VAR } from "./charts/chartUtils";
import { useCountUp } from "./charts/useCountUp";

type Outlook = RouterOutputs["user"]["getNightOutlook"];
type NightMetric = NonNullable<Outlook["lastNight"]>;

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

      <div className="grid grid-cols-3 gap-2">
        <NightColumn
          label="Two nights ago"
          night={data.nightBefore}
          reference={null}
        />
        <NightColumn
          label="Last night"
          night={data.lastNight}
          reference={data.nightBefore}
          emphasis
        />
        <ForecastColumn
          night={data.tonight.night}
          forecast={forecast}
          mid={forecastMid}
          planned={data.tonight.planned}
          reference={data.lastNight}
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

const NightColumn: React.FC<{
  label: string;
  night: NightMetric | null;
  reference: NightMetric | null;
  emphasis?: boolean;
}> = ({ label, night, reference, emphasis }) => {
  const tone = scoreTone(night?.score ?? null);
  const animated = useCountUp(night?.score ?? null, emphasis ? 800 : 500);

  return (
    <div
      className="tile flex flex-col"
      style={
        emphasis
          ? { borderColor: "var(--border-strong)", backgroundColor: "var(--surface)" }
          : undefined
      }
    >
      <div className="tile-label">{label}</div>
      <div
        className="mt-1 text-[10px]"
        style={{ color: "var(--text-faint)", minHeight: "1rem" }}
      >
        {night
          ? new Date(`${night.night}T12:00:00Z`).toLocaleDateString("en-GB", {
              weekday: "short",
              day: "numeric",
              month: "short",
            })
          : "no record"}
      </div>

      <div className="mt-1 flex items-baseline gap-1.5">
        <span
          className="tabular text-3xl font-semibold leading-none"
          style={{ color: night?.score == null ? "var(--text-faint)" : TONE_VAR[tone] }}
        >
          {night?.score == null ? "—" : Math.round(animated)}
        </span>
        <Change
          current={night?.score ?? null}
          previous={reference?.score ?? null}
          format={(v) => Math.round(v).toString()}
        />
      </div>

      <dl className="mt-3 space-y-1">
        <Row
          label="Asleep"
          value={formatHours(night?.asleepHours)}
          delta={
            <Change
              current={night?.asleepHours ?? null}
              previous={reference?.asleepHours ?? null}
              format={(v) => `${Math.round(v * 60)}m`}
            />
          }
        />
        <Row
          label="Deep"
          value={formatHours(night?.deepHours)}
          delta={
            <Change
              current={night?.deepHours ?? null}
              previous={reference?.deepHours ?? null}
              format={(v) => `${Math.round(v * 60)}m`}
            />
          }
        />
        <Row
          label="Tosses"
          value={night?.tosses == null ? "—" : String(night.tosses)}
          delta={
            <Change
              current={night?.tosses ?? null}
              previous={reference?.tosses ?? null}
              higherIsBetter={false}
              format={(v) => String(Math.round(v))}
            />
          }
        />
      </dl>
    </div>
  );
};

/** Tonight is a prediction, so it is drawn as one: dashed border, a range
 *  rather than a number, and never the solid treatment the measured nights get. */
const ForecastColumn: React.FC<{
  night: string;
  forecast: NonNullable<Outlook["tonight"]>["forecast"];
  mid: number | null;
  planned: boolean;
  reference: NightMetric | null;
}> = ({ night, forecast, mid, planned, reference }) => {
  const animated = useCountUp(mid, 900);
  const tone = scoreTone(mid);

  return (
    <div
      className="flex flex-col rounded-xl p-2.5"
      style={{
        border: "1px dashed var(--border-strong)",
        backgroundColor: "transparent",
      }}
    >
      <div className="tile-label" style={{ color: "var(--accent)" }}>
        Tonight
      </div>
      <div className="mt-1 text-[10px]" style={{ color: "var(--text-faint)", minHeight: "1rem" }}>
        {planned ? "expected" : "not planned yet"}
      </div>

      <div className="mt-1 flex items-baseline gap-1.5">
        {forecast ? (
          <>
            <span
              className="tabular text-3xl font-semibold leading-none"
              style={{ color: TONE_VAR[tone] }}
            >
              {Math.round(animated)}
            </span>
            <span
              className="tabular text-[11px]"
              style={{ color: "var(--text-faint)" }}
            >
              {forecast.expectedScoreLow}–{forecast.expectedScoreHigh}
            </span>
          </>
        ) : (
          <span
            className="tabular text-3xl font-semibold leading-none"
            style={{ color: "var(--text-faint)" }}
          >
            —
          </span>
        )}
      </div>

      <dl className="mt-3 space-y-1">
        <Row
          label="Deep"
          value={
            forecast?.expectedDeepHours == null
              ? "—"
              : formatHours(forecast.expectedDeepHours)
          }
          delta={
            <Change
              current={forecast?.expectedDeepHours ?? null}
              previous={reference?.deepHours ?? null}
              format={(v) => `${Math.round(v * 60)}m`}
            />
          }
        />
        <Row
          label="Tosses"
          value={
            forecast?.expectedTosses == null
              ? "—"
              : String(Math.round(forecast.expectedTosses))
          }
          delta={
            <Change
              current={forecast?.expectedTosses ?? null}
              previous={reference?.tosses ?? null}
              higherIsBetter={false}
              format={(v) => String(Math.round(v))}
            />
          }
        />
        <Row
          label="Night of"
          value={new Date(`${night}T12:00:00Z`).toLocaleDateString("en-GB", {
            weekday: "short",
            day: "numeric",
          })}
        />
      </dl>
    </div>
  );
};

const Row: React.FC<{
  label: string;
  value: string;
  delta?: React.ReactNode;
}> = ({ label, value, delta }) => (
  <div className="flex items-baseline justify-between gap-1">
    <dt className="text-[11px]" style={{ color: "var(--text-muted)" }}>
      {label}
    </dt>
    <dd className="flex items-baseline gap-1">
      <span
        className="tabular text-[12px] font-semibold"
        style={{ color: "var(--text-headline)" }}
      >
        {value}
      </span>
      {delta}
    </dd>
  </div>
);

const Change: React.FC<{
  current: number | null;
  previous: number | null;
  higherIsBetter?: boolean;
  format: (value: number) => string;
}> = ({ current, previous, higherIsBetter = true, format }) => {
  if (current == null || previous == null) return null;
  const diff = current - previous;
  if (Math.abs(diff) < 0.005) return null;
  const better = higherIsBetter ? diff > 0 : diff < 0;
  return (
    <span
      className="tabular text-[10px] font-semibold"
      style={{ color: better ? "var(--success)" : "var(--danger)" }}
    >
      {diff > 0 ? "+" : "−"}
      {format(Math.abs(diff))}
    </span>
  );
};
