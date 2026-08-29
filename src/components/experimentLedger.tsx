"use client";
import React from "react";
import { formatRawByUnit, type DisplayUnit } from "~/lib/temperature";
import { scoreTone, TONE_VAR } from "./charts/chartUtils";

const STAGES = ["initial", "deep", "mid", "final"] as const;

const STAGE_LABEL: Record<string, string> = {
  initial: "falling asleep",
  deep: "deep sleep",
  mid: "middle of the night",
  final: "REM and wake-up",
};

export interface Experiment {
  profile: { initial: number; deep: number; mid: number; final: number };
  nights: string[];
  meanThermal: number;
  best: boolean;
  current: boolean;
}

export interface Pressure {
  stage: string;
  meanOffsetC: number;
  nights: number;
}

/**
 * What has actually been tried, and what it scored. The loop reasons over
 * this, so showing anything else would let the app and the advisor tell
 * different stories.
 */
export const ExperimentLedger: React.FC<{
  experiments: Experiment[];
  pressure: Pressure[];
  unit: DisplayUnit;
}> = ({ experiments, pressure, unit }) => {
  if (experiments.length === 0 && pressure.length === 0) return null;

  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <span className="card-title">What has been tried</span>
        <span className="text-[11px]" style={{ color: "var(--text-faint)" }}>
          scored on sleep quality only
        </span>
      </div>

      {pressure.length > 0 && (
        <div
          className="mb-3 rounded-xl p-3 text-xs leading-relaxed"
          style={{ backgroundColor: "var(--cool-soft)", color: "var(--text)" }}
        >
          {pressure.map((p) => (
            <div key={p.stage}>
              Live tuning has had to{" "}
              <span className="font-semibold">
                {p.meanOffsetC < 0 ? "cool" : "warm"}
              </span>{" "}
              the {STAGE_LABEL[p.stage] ?? p.stage} stage on {p.nights} of the
              last 3 nights, by {Math.abs(p.meanOffsetC).toFixed(1)}°C on
              average — a sign the setting underneath is wrong, not the night.
            </div>
          ))}
        </div>
      )}

      {experiments.length === 0 ? (
        <p className="text-xs" style={{ color: "var(--text-muted)" }}>
          No measured nights yet. A profile needs two nights the pod provably
          ran before it can be compared with anything.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {experiments.map((entry, index) => {
            const shape = STAGES.map((stage) =>
              formatRawByUnit(entry.profile[stage], unit),
            ).join(" / ");
            const tone = scoreTone(Math.round(entry.meanThermal));
            const thin = entry.nights.length < 2;
            return (
              <li
                key={`${shape}-${index}`}
                className="enter flex items-center gap-3 rounded-lg px-2 py-1.5"
                style={
                  {
                    backgroundColor: entry.current
                      ? "var(--surface-sunken)"
                      : "transparent",
                    outline: entry.current
                      ? "1px solid var(--border-strong)"
                      : undefined,
                    "--i": index,
                  } as React.CSSProperties
                }
              >
                <span
                  className="tabular w-9 shrink-0 text-center text-[15px] font-semibold"
                  style={{ color: thin ? "var(--text-faint)" : TONE_VAR[tone] }}
                >
                  {Math.round(entry.meanThermal)}
                </span>
                <span className="min-w-0 flex-1">
                  <span
                    className="tabular block truncate text-[12px] font-medium"
                    style={{ color: "var(--text-headline)" }}
                  >
                    {shape}
                  </span>
                  <span
                    className="block text-[10px]"
                    style={{ color: "var(--text-faint)" }}
                  >
                    {entry.nights.length} night
                    {entry.nights.length === 1 ? "" : "s"}
                    {thin ? " — too few to judge" : ""}
                  </span>
                </span>
                <span className="flex shrink-0 gap-1">
                  {entry.current && (
                    <span
                      className="chip"
                      style={{
                        color: "var(--accent)",
                        backgroundColor: "var(--accent-soft)",
                      }}
                    >
                      now
                    </span>
                  )}
                  {entry.best && (
                    <span
                      className="chip"
                      style={{
                        color: "var(--success)",
                        backgroundColor: "var(--success-soft)",
                      }}
                    >
                      best
                    </span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      <p className="mt-2 text-[10px]" style={{ color: "var(--text-faint)" }}>
        Scored on deep-sleep share, REM share, restlessness and time awake —
        not on how long you slept or when you went to bed, which the bed
        cannot change.
      </p>
    </div>
  );
};
