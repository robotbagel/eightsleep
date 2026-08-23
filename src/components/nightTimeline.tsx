"use client";
import React from "react";
import { apiR } from "~/trpc/react";
import { formatRawByUnit, type DisplayUnit } from "~/lib/temperature";

function clockIn(iso: string, timezone: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
  });
}

const STAGE_LABEL: Record<string, string> = {
  "pre-heating": "Pre-heating",
  initial: "Initial",
  deep: "Deep",
  mid: "Mid",
  final: "Final",
  wake: "Wake-up",
};

export const NightTimeline: React.FC<{ displayUnit: DisplayUnit }> = ({
  displayUnit,
}) => {
  const timelineQuery = apiR.user.getNightTimeline.useQuery(undefined, {
    refetchOnWindowFocus: false,
  });

  if (timelineQuery.isLoading) {
    return (
      <div className="mx-auto mt-4 w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
        <h2 className="mb-2 text-center text-2xl font-bold text-gray-800">
          Night Timeline
        </h2>
        <p className="text-center text-sm text-gray-500">Loading…</p>
      </div>
    );
  }

  const data = timelineQuery.data;
  if (!data?.night) return null;

  const { timezone, events, session } = data;

  // Merge our temperature changes with the pod's own events into one
  // chronological list.
  type Row = {
    at: string;
    kind: "temp" | "toss" | "sleep";
    label: string;
    detail?: string;
  };
  const rows: Row[] = [];

  for (const event of events) {
    const at = new Date(event.at).toISOString();
    rows.push({
      at,
      kind: "temp",
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
    });
  }

  if (session?.sleepStart) {
    rows.push({ at: session.sleepStart, kind: "sleep", label: "Fell asleep" });
  }
  if (session?.sleepEnd) {
    rows.push({ at: session.sleepEnd, kind: "sleep", label: "Woke up" });
  }

  // Group toss events into clusters so the list stays readable.
  const tossTimes = (session?.tnt ?? []).map(([t]) => new Date(t).getTime());
  tossTimes.sort((a, b) => a - b);
  let cluster: number[] = [];
  const flush = () => {
    if (cluster.length === 0) return;
    rows.push({
      at: new Date(cluster[0]!).toISOString(),
      kind: "toss",
      label: `${cluster.length} toss${cluster.length > 1 ? "es" : ""} & turns`,
      detail:
        cluster.length > 1
          ? `until ${clockIn(new Date(cluster[cluster.length - 1]!).toISOString(), timezone)}`
          : undefined,
    });
    cluster = [];
  };
  for (const t of tossTimes) {
    if (cluster.length > 0 && t - cluster[cluster.length - 1]! > 20 * 60 * 1000) {
      flush();
    }
    cluster.push(t);
  }
  flush();

  rows.sort((a, b) => (a.at < b.at ? -1 : 1));

  const bedTemps = session?.tempBedC ?? [];
  const heartRates = (session?.heartRate ?? []).map(([, v]) => v);
  const avgHr =
    heartRates.length > 0
      ? Math.round(heartRates.reduce((s, v) => s + v, 0) / heartRates.length)
      : null;

  return (
    <div className="mx-auto mt-4 w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
      <h2 className="mb-1 text-center text-2xl font-bold text-gray-800">
        Night Timeline
      </h2>
      <p className="mb-4 text-center text-sm text-gray-500">
        {data.night} — every temperature change and what your pod measured.
      </p>

      <div className="mb-4 grid grid-cols-3 gap-2 text-center">
        <div className="rounded-md bg-gray-50 p-2">
          <div className="text-xs text-gray-500">Tosses</div>
          <div className="text-sm font-semibold text-gray-800">
            {session?.tnt.length ?? 0}
          </div>
        </div>
        <div className="rounded-md bg-gray-50 p-2">
          <div className="text-xs text-gray-500">Avg heart rate</div>
          <div className="text-sm font-semibold text-gray-800">
            {avgHr != null ? `${avgHr} bpm` : "—"}
          </div>
        </div>
        <div className="rounded-md bg-gray-50 p-2">
          <div className="text-xs text-gray-500">Bed temp range</div>
          <div className="text-sm font-semibold text-gray-800">
            {bedTemps.length > 0
              ? `${Math.min(...bedTemps.map(([, v]) => v)).toFixed(0)}–${Math.max(...bedTemps.map(([, v]) => v)).toFixed(0)}°C`
              : "—"}
          </div>
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="text-center text-sm text-gray-500">
          No events recorded for this night yet.
        </p>
      ) : (
        <ol className="space-y-2">
          {rows.map((row, index) => (
            <li key={index} className="flex gap-3 text-sm">
              <span className="w-12 shrink-0 font-mono text-xs text-gray-500">
                {clockIn(row.at, timezone)}
              </span>
              <span
                className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                  row.kind === "temp"
                    ? "bg-indigo-500"
                    : row.kind === "toss"
                      ? "bg-amber-400"
                      : "bg-gray-400"
                }`}
              />
              <span className="flex-1">
                <span
                  className={
                    row.kind === "temp"
                      ? "font-medium text-gray-800"
                      : "text-gray-700"
                  }
                >
                  {row.label}
                </span>
                {row.detail && (
                  <span className="block text-xs text-gray-500">
                    {row.detail}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
};
