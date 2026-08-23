"use client";
import React from "react";
import { apiR } from "~/trpc/react";
import { Card, CardHeader, Skeleton, Tile } from "./ui/card";
import { ScoreRing } from "./charts/scoreRing";
import { StageBar } from "./charts/stageBar";
import { Sparkline } from "./charts/sparkline";
import { formatHours, scoreTone, TONE_VAR, type Point } from "./charts/chartUtils";

const VERDICT: Record<"good" | "warn" | "bad" | "none", string> = {
  good: "Strong night",
  warn: "Decent night",
  bad: "Rough night",
  none: "No score yet",
};

export const LastNightCard: React.FC<{ index?: number }> = ({ index = 0 }) => {
  const query = apiR.user.getSleepSummary.useQuery(undefined, {
    retry: 1,
    refetchOnWindowFocus: false,
  });

  if (query.isLoading) {
    return (
      <Card index={index}>
        <CardHeader icon="sleep" title="Last night" />
        <div className="flex items-center gap-5">
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

  if (query.isError || !query.data) {
    return (
      <Card index={index}>
        <CardHeader icon="sleep" title="Last night" />
        <p className="text-sm" style={{ color: "var(--text-muted)" }}>
          Eight Sleep did not return your sleep data just now.
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

  const { nights, recentSessions } = query.data;
  const session = recentSessions[0];
  const night = nights[nights.length - 1];

  if (!session && !night) {
    return (
      <Card index={index}>
        <CardHeader icon="sleep" title="Last night" />
        <p className="text-sm" style={{ color: "var(--text-muted)" }}>
          No finished sleep session yet. Sleep on the pod tonight and this fills
          itself in by morning.
        </p>
      </Card>
    );
  }

  const score = session?.score ?? night?.score ?? null;
  const tone = scoreTone(score);
  const asleep = night?.sleepDurationHours ?? null;

  const toEpoch = (date: string) => new Date(`${date}T12:00:00Z`).getTime();
  const seriesOf = (
    key: "restingHeartRate" | "hrv" | "respiratoryRate",
  ): Point[] =>
    nights
      .filter((n) => n[key] != null)
      .map((n) => [toEpoch(n.date), n[key]!] as Point);

  const hrSeries = seriesOf("restingHeartRate");
  const hrvSeries = seriesOf("hrv");
  const brSeries = seriesOf("respiratoryRate");

  const tosses = session
    ? [
        session.tossesAndTurns.firstThird,
        session.tossesAndTurns.middleThird,
        session.tossesAndTurns.finalThird,
      ].reduce<number>((sum, value) => sum + (value ?? 0), 0)
    : 0;

  const dateLabel = session?.date ?? night?.date;

  return (
    <Card index={index}>
      <CardHeader
        icon="sleep"
        title="Last night"
        subtitle={
          dateLabel
            ? new Date(`${dateLabel}T12:00:00Z`).toLocaleDateString("en-GB", {
                weekday: "long",
                day: "numeric",
                month: "long",
              })
            : undefined
        }
        right={
          <span
            className="chip"
            style={{
              backgroundColor:
                tone === "good"
                  ? "var(--success-soft)"
                  : tone === "warn"
                    ? "var(--warning-soft)"
                    : tone === "bad"
                      ? "var(--danger-soft)"
                      : "var(--surface-sunken)",
              color: TONE_VAR[tone],
              borderColor: "transparent",
            }}
          >
            {VERDICT[tone]}
          </span>
        }
      />

      <div className="flex flex-col items-center gap-5 sm:flex-row sm:items-center">
        <ScoreRing score={score} />
        <div className="w-full flex-1">
          <div className="flex items-baseline gap-2">
            <span
              className="tabular text-4xl font-semibold leading-none"
              style={{ color: "var(--text-headline)" }}
            >
              {formatHours(asleep)}
            </span>
            <span className="text-sm" style={{ color: "var(--text-muted)" }}>
              asleep
            </span>
          </div>
          {session && Object.keys(session.stageHours).length > 0 && (
            <div className="mt-4">
              <StageBar stageHours={session.stageHours} />
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
            night?.restingHeartRate != null ? (
              <>
                {Math.round(night.restingHeartRate)}
                <span className="ml-1 text-xs font-normal" style={{ color: "var(--text-faint)" }}>
                  bpm
                </span>
              </>
            ) : (
              "—"
            )
          }
        >
          <Sparkline series={hrSeries} color="var(--danger)" />
        </Tile>

        <Tile
          icon="chart"
          label="HRV"
          color="var(--accent)"
          value={
            night?.hrv != null ? (
              <>
                {Math.round(night.hrv)}
                <span className="ml-1 text-xs font-normal" style={{ color: "var(--text-faint)" }}>
                  ms
                </span>
              </>
            ) : (
              "—"
            )
          }
        >
          <Sparkline series={hrvSeries} color="var(--accent)" />
        </Tile>

        <Tile
          icon="lungs"
          label="Breathing"
          color="var(--cool)"
          value={
            night?.respiratoryRate != null ? (
              <>
                {night.respiratoryRate.toFixed(1)}
                <span className="ml-1 text-xs font-normal" style={{ color: "var(--text-faint)" }}>
                  /min
                </span>
              </>
            ) : (
              "—"
            )
          }
        >
          <Sparkline series={brSeries} color="var(--cool)" />
        </Tile>

        <Tile
          icon="bed"
          label="Tosses"
          color="var(--stage-awake)"
          value={tosses}
          sub={
            session
              ? `${session.tossesAndTurns.firstThird ?? 0} / ${session.tossesAndTurns.middleThird ?? 0} / ${session.tossesAndTurns.finalThird ?? 0} by third`
              : undefined
          }
        />
      </div>
    </Card>
  );
};
