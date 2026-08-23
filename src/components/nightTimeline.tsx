"use client";
import React, { useState } from "react";
import { apiR } from "~/trpc/react";
import { formatRawByUnit, type DisplayUnit } from "~/lib/temperature";
import { Card, CardHeader, Skeleton, Tile } from "./ui/card";
import { NightChart, type NightEvent } from "./charts/nightChart";
import { clockIn, formatHours } from "./charts/chartUtils";

const STAGE_LABEL: Record<string, string> = {
  "pre-heating": "Pre-heating",
  initial: "Initial",
  deep: "Deep",
  mid: "Mid",
  final: "Final",
  wake: "Wake-up",
};

const SOURCE_META: Record<
  NightEvent["source"],
  { label: string; color: string }
> = {
  schedule: { label: "Scheduled", color: "var(--accent)" },
  live: { label: "Live nudge", color: "var(--warm)" },
  off: { label: "Off", color: "var(--text-faint)" },
};

export const NightTimeline: React.FC<{
  displayUnit: DisplayUnit;
  index?: number;
}> = ({ displayUnit, index = 0 }) => {
  const [showLog, setShowLog] = useState(false);
  const timelineQuery = apiR.user.getNightTimeline.useQuery(undefined, {
    refetchOnWindowFocus: false,
  });

  if (timelineQuery.isLoading) {
    return (
      <Card index={index}>
        <CardHeader icon="clock" title="Your night, hour by hour" />
        <Skeleton className="h-[200px]" />
      </Card>
    );
  }

  const data = timelineQuery.data;
  if (!data?.night) {
    return (
      <Card index={index}>
        <CardHeader icon="clock" title="Your night, hour by hour" />
        <p className="text-sm" style={{ color: "var(--text-muted)" }}>
          Once the pod records a full night, every stage change, toss and
          temperature move lands on this chart.
        </p>
      </Card>
    );
  }

  const { timezone, events, session } = data;
  const ms = (iso: string | null | undefined) =>
    iso ? new Date(iso).getTime() : null;

  const chartEvents: NightEvent[] = events.map((event) => ({
    at: new Date(event.at).getTime(),
    label:
      event.level != null
        ? `${STAGE_LABEL[event.stage] ?? event.stage} → ${formatRawByUnit(event.level, displayUnit)}`
        : `${STAGE_LABEL[event.stage] ?? event.stage} → off`,
    detail:
      event.source === "live"
        ? (event.note ?? "Live adjustment")
        : event.source === "off"
          ? "Scheduled off"
          : "Scheduled stage change",
    source:
      event.source === "live"
        ? "live"
        : event.source === "off"
          ? "off"
          : "schedule",
  }));

  const tosses = (session?.tnt ?? []).map(([t]) => new Date(t).getTime());
  const bed = (session?.tempBedC ?? []).map(
    ([t, v]) => [new Date(t).getTime(), v] as [number, number],
  );
  const room = (session?.tempRoomC ?? []).map(
    ([t, v]) => [new Date(t).getTime(), v] as [number, number],
  );

  const sleepStart = ms(session?.sleepStart);
  const sleepEnd = ms(session?.sleepEnd);
  const inBed =
    sleepStart != null && sleepEnd != null
      ? (sleepEnd - sleepStart) / 3_600_000
      : null;

  const liveNudges = chartEvents.filter((e) => e.source === "live").length;

  return (
    <Card index={index}>
      <CardHeader
        icon="clock"
        title="Your night, hour by hour"
        subtitle={new Date(`${data.night}T12:00:00Z`).toLocaleDateString(
          "en-GB",
          { weekday: "long", day: "numeric", month: "long" },
        )}
      />

      <div className="mb-4 grid grid-cols-3 gap-2">
        <Tile
          label="In bed"
          value={formatHours(inBed)}
          sub={
            sleepStart != null && sleepEnd != null
              ? `${clockIn(sleepStart, timezone)} → ${clockIn(sleepEnd, timezone)}`
              : undefined
          }
        />
        <Tile
          label="Bed temp"
          icon="thermometer"
          color="var(--warm)"
          value={
            bed.length > 0
              ? `${Math.min(...bed.map(([, v]) => v)).toFixed(0)}–${Math.max(...bed.map(([, v]) => v)).toFixed(0)}°C`
              : "—"
          }
          sub="range across the night"
        />
        <Tile
          label="AI nudges"
          icon="ai"
          value={liveNudges}
          sub={liveNudges === 0 ? "steady all night" : "mid-night changes"}
        />
      </div>

      <NightChart
        timezone={timezone}
        sessionStart={ms(session?.sessionStart)}
        sleepStart={sleepStart}
        sleepEnd={sleepEnd}
        stages={session?.stages ?? []}
        bed={bed}
        room={room}
        tosses={tosses}
        events={chartEvents}
      />

      <button
        type="button"
        onClick={() => setShowLog(!showLog)}
        aria-expanded={showLog}
        className="btn btn-ghost mt-3 w-full justify-between px-0 text-sm"
      >
        <span>
          {showLog ? "Hide" : "Show"} the event log
          <span className="ml-1.5" style={{ color: "var(--text-faint)" }}>
            ({chartEvents.length})
          </span>
        </span>
        <span
          className="transition-transform duration-fast ease-snap"
          style={{ transform: showLog ? "rotate(180deg)" : undefined }}
          aria-hidden="true"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path
              d="M2.5 4.5 6 8l3.5-3.5"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      </button>

      <div
        className="grid transition-[grid-template-rows] duration-base ease-snap"
        style={{ gridTemplateRows: showLog ? "1fr" : "0fr" }}
      >
        <div className="overflow-hidden">
          {chartEvents.length === 0 ? (
            <p
              className="pt-2 text-sm"
              style={{ color: "var(--text-muted)" }}
            >
              No temperature changes were sent to the pod this night.
            </p>
          ) : (
            <ol className="space-y-1 pt-2">
              {chartEvents
                .slice()
                .sort((a, b) => a.at - b.at)
                .map((event, i) => (
                  <li
                    key={`${event.at}-${i}`}
                    className="flex items-start gap-3 rounded-lg px-2 py-1.5 transition-colors duration-fast ease-snap hover:bg-[var(--surface-hover)]"
                  >
                    <span
                      className="tabular w-11 shrink-0 pt-0.5 text-xs"
                      style={{ color: "var(--text-faint)" }}
                    >
                      {clockIn(event.at, timezone)}
                    </span>
                    <span
                      className="mt-1.5 h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: SOURCE_META[event.source].color }}
                    />
                    <span className="flex-1">
                      <span
                        className="block text-sm font-medium"
                        style={{ color: "var(--text-headline)" }}
                      >
                        {event.label}
                      </span>
                      <span
                        className="block text-xs"
                        style={{ color: "var(--text-muted)" }}
                      >
                        {event.detail}
                      </span>
                    </span>
                  </li>
                ))}
            </ol>
          )}
        </div>
      </div>
    </Card>
  );
};
