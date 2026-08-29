"use client";
import React from "react";
import { apiR } from "~/trpc/react";
import { Card, Skeleton, Tile } from "./ui/card";
import { NightNav } from "./nightNav";
import { ScoreRing } from "./charts/scoreRing";
import { StageBar } from "./charts/stageBar";
import { Sparkline } from "./charts/sparkline";
import { TONE_VAR, type Point } from "./charts/chartUtils";
import { buildVerdict } from "~/lib/verdict";

function clockOf(minutes: number | null | undefined): string {
  if (minutes == null) return "—";
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

export const NightSummaryCard: React.FC<{
  night: string | null;
  nav: React.ComponentProps<typeof NightNav>;
  index?: number;
}> = ({ night, nav, index = 0 }) => {
  const query = apiR.user.getNightTimeline.useQuery(
    night ? { night } : undefined,
    { retry: 1, refetchOnWindowFocus: false },
  );
  // Two weeks of context for the tile sparklines. Same key as the compare
  // card's default range, so it costs one request between them.
  const history = apiR.user.getSleepHistory.useQuery(
    { days: 14 },
    { retry: 1, refetchOnWindowFocus: false },
  );

  const metrics = query.data?.metrics ?? null;
  const stageHours = query.data?.session?.stageHours ?? {};

  const seriesOf = (
    key: "restingHeartRate" | "hrv" | "respiratoryRate",
  ): Point[] =>
    (history.data?.nights ?? [])
      .filter((n) => n[key] != null)
      .map((n) => [new Date(`${n.night}T12:00:00Z`).getTime(), n[key]!] as Point);

  if (query.isLoading) {
    return (
      <Card index={index}>
        <NightNav {...nav} />
        <div className="mt-5 flex items-center gap-5">
          <Skeleton className="h-[132px] w-[132px] rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-7 w-32" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-3/4" />
          </div>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-[76px]" />
          ))}
        </div>
      </Card>
    );
  }

  if (query.isError) {
    return (
      <Card index={index}>
        <NightNav {...nav} />
        <p className="mt-4 text-sm" style={{ color: "var(--text-muted)" }}>
          Eight Sleep did not return this night just now.
        </p>
        <button
          type="button"
          onClick={() => void query.refetch()}
          className="btn btn-secondary mt-3"
        >
          Try again
        </button>
      </Card>
    );
  }

  if (!metrics) {
    return (
      <Card index={index}>
        <NightNav {...nav} />
        <div className="relative overflow-hidden rounded-xl px-4 py-8 text-center">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-6 bottom-4 space-y-2 opacity-[0.12]"
          >
            {[70, 90, 55].map((width, i) => (
              <div
                key={i}
                className="h-2.5 rounded-full"
                style={{ width: `${width}%`, backgroundColor: "var(--accent)" }}
              />
            ))}
          </div>
          <p className="relative text-sm" style={{ color: "var(--text-muted)" }}>
            The pod recorded no sleep for this night.
          </p>
          {nav.canNext && (
            <button
              type="button"
              onClick={nav.onLatest}
              className="btn btn-primary relative mx-auto mt-4"
            >
              Jump to the latest night
            </button>
          )}
        </div>
      </Card>
    );
  }

  // "Compared with usual" needs a reference; the same 14 nights the tile
  // sparklines already use, so there is no extra request.
  const recent = (history.data?.nights ?? []).filter(
    (n) => n.night !== metrics.night,
  );
  const mean = (key: "asleepHours" | "deepHours" | "tosses") => {
    const values = recent
      .map((n) => n[key])
      .filter((v): v is number => typeof v === "number");
    return values.length === 0
      ? null
      : values.reduce((a, b) => a + b, 0) / values.length;
  };
  const verdict = buildVerdict({
    asleepHours: metrics.asleepHours,
    deepHours: metrics.deepHours,
    remHours: metrics.remHours,
    tosses: metrics.tosses,
    wakeCount: metrics.wakeCount,
    thermalScore: metrics.thermalScore,
    average: {
      asleepHours: mean("asleepHours"),
      deepHours: mean("deepHours"),
      tosses: mean("tosses"),
    },
  });

  return (
    <Card index={index}>
      <NightNav {...nav} />

      {/* The answer, before any chart. Score, one headline, one sentence. */}
      <div className="mt-5 flex flex-col items-center gap-5 sm:flex-row sm:items-start">
        <ScoreRing score={metrics.thermalScore ?? metrics.score} label="quality" />
        <div className="w-full min-w-0 flex-1">
          <h3
            className="text-2xl font-semibold leading-tight tracking-[-0.02em]"
            style={{ color: TONE_VAR[verdict.tone] }}
          >
            {verdict.headline}
          </h3>
          <p
            className="mt-1.5 text-sm leading-relaxed"
            style={{ color: "var(--text)" }}
          >
            {verdict.detail}
          </p>
          <p
            className="tabular mt-2 text-xs"
            style={{ color: "var(--text-faint)" }}
          >
            {clockOf(metrics.bedtimeMinutes)} → {clockOf(metrics.wakeMinutes)}
            {metrics.score != null && (
              <span
                title="Apple-style overall score: half duration, a third bedtime consistency. Useful context, but not what the autopilot tunes."
              >
                {" · overall "}
                {metrics.score}/100
              </span>
            )}
          </p>
          {Object.keys(stageHours).length > 0 && (
            <div className="mt-4">
              <StageBar stageHours={stageHours} compact />
            </div>
          )}
        </div>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Tile
          icon="heart"
          label="Resting HR"
          color="var(--danger)"
          value={
            metrics.restingHeartRate != null ? (
              <>
                {Math.round(metrics.restingHeartRate)}
                <Unit>bpm</Unit>
              </>
            ) : (
              "—"
            )
          }
        >
          <Sparkline series={seriesOf("restingHeartRate")} color="var(--danger)" />
        </Tile>

        <Tile
          icon="chart"
          label="HRV"
          color="var(--accent)"
          value={
            metrics.hrv != null ? (
              <>
                {Math.round(metrics.hrv)}
                <Unit>ms</Unit>
              </>
            ) : (
              "—"
            )
          }
        >
          <Sparkline series={seriesOf("hrv")} color="var(--accent)" />
        </Tile>

        <Tile
          icon="lungs"
          label="Breathing"
          color="var(--cool)"
          value={
            metrics.respiratoryRate != null ? (
              <>
                {metrics.respiratoryRate.toFixed(1)}
                <Unit>/min</Unit>
              </>
            ) : (
              "—"
            )
          }
        >
          <Sparkline series={seriesOf("respiratoryRate")} color="var(--cool)" />
        </Tile>

        <Tile
          icon="bed"
          label="Tosses"
          color="var(--stage-awake)"
          value={metrics.tosses ?? "—"}
          sub={
            metrics.wakeCount != null
              ? `${metrics.wakeCount} brief wake-up${metrics.wakeCount === 1 ? "" : "s"}`
              : undefined
          }
        />
      </div>
    </Card>
  );
};

const Unit: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span className="ml-1 text-xs font-normal" style={{ color: "var(--text-faint)" }}>
    {children}
  </span>
);
