"use client";
import React from "react";
import { formatRawByUnit, rawToCelsius, type DisplayUnit } from "~/lib/temperature";

export interface StageChange {
  label: string;
  /** What actually ran last night, when we have a record of it. */
  lastNight?: number | null;
  /** What is loaded for tonight — the authoritative "current" value. */
  tonight: number;
  /** A recommendation that has not been applied, when one is waiting. */
  proposed?: number | null;
}

/**
 * One track per stage on a shared temperature axis, carrying up to three
 * marks: where the bed was last night (hollow), where it is set for tonight
 * (filled), and where a pending proposal would put it (ring). The point is to
 * make "did this change?" answerable at a glance instead of by comparing two
 * numbers in prose.
 */
export const StageChangeChart: React.FC<{
  changes: StageChange[];
  unit: DisplayUnit;
}> = ({ changes, unit }) => {
  if (changes.length === 0) return null;

  const values = changes.flatMap((c) =>
    [c.lastNight, c.tonight, c.proposed]
      .filter((v): v is number => v != null)
      .map(rawToCelsius),
  );
  const lo = Math.min(...values) - 1;
  const hi = Math.max(...values) + 1;
  const position = (raw: number) => ((rawToCelsius(raw) - lo) / (hi - lo || 1)) * 100;

  return (
    <div className="space-y-2.5">
      {changes.map((change, index) => {
        const from = change.lastNight ?? null;
        const moved = from != null && from !== change.tonight;
        const cooler = moved && change.tonight < from;
        const moveColor = cooler ? "var(--cool)" : "var(--warm)";
        const proposed =
          change.proposed != null && change.proposed !== change.tonight
            ? change.proposed
            : null;

        return (
          <div
            key={change.label}
            className="enter"
            style={{ "--i": index } as React.CSSProperties}
          >
            <div className="mb-1 flex items-baseline justify-between gap-2">
              <span className="text-xs" style={{ color: "var(--text-muted)" }}>
                {change.label}
              </span>
              <span className="tabular text-xs font-semibold">
                {from != null && (
                  <>
                    <span style={{ color: "var(--text-faint)" }}>
                      {formatRawByUnit(from, unit)}
                    </span>
                    <span
                      className="mx-1"
                      aria-hidden="true"
                      style={{ color: "var(--text-faint)" }}
                    >
                      →
                    </span>
                  </>
                )}
                <span
                  style={{
                    color: moved ? moveColor : "var(--text-headline)",
                  }}
                >
                  {formatRawByUnit(change.tonight, unit)}
                </span>
                {!moved && from != null && (
                  <span className="ml-1.5" style={{ color: "var(--text-faint)" }}>
                    unchanged
                  </span>
                )}
                {proposed != null && (
                  <>
                    <span
                      className="mx-1"
                      aria-hidden="true"
                      style={{ color: "var(--text-faint)" }}
                    >
                      ⇢
                    </span>
                    <span style={{ color: "var(--accent)" }}>
                      {formatRawByUnit(proposed, unit)}
                    </span>
                  </>
                )}
              </span>
            </div>

            <div
              className="relative h-4"
              role="img"
              aria-label={describe(change, unit)}
            >
              <span
                className="absolute left-0 right-0 top-1/2 h-[3px] -translate-y-1/2 rounded-full"
                style={{ backgroundColor: "var(--surface-sunken)" }}
              />
              {moved && (
                <span
                  className="grow-seg absolute top-1/2 h-[3px] -translate-y-1/2 rounded-full"
                  style={
                    {
                      left: `${Math.min(position(from), position(change.tonight))}%`,
                      width: `${Math.abs(position(change.tonight) - position(from))}%`,
                      backgroundColor: moveColor,
                      "--i": index,
                    } as React.CSSProperties
                  }
                />
              )}
              {from != null && (
                <span
                  className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2"
                  style={{
                    left: `${position(from)}%`,
                    borderColor: "var(--border-strong)",
                    backgroundColor: "var(--surface)",
                  }}
                />
              )}
              <span
                className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 transition-transform duration-base ease-snap"
                style={{
                  left: `${position(change.tonight)}%`,
                  backgroundColor: moved ? moveColor : "var(--text-muted)",
                  borderColor: "var(--surface)",
                }}
              />
              {proposed != null && (
                <span
                  className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2"
                  style={{
                    left: `${position(proposed)}%`,
                    borderColor: "var(--accent)",
                    backgroundColor: "var(--surface)",
                  }}
                />
              )}
            </div>
          </div>
        );
      })}

      <div
        className="flex justify-between pt-0.5 text-[10px]"
        style={{ color: "var(--text-faint)" }}
      >
        <span>cooler</span>
        <span>warmer</span>
      </div>
    </div>
  );
};

function describe(change: StageChange, unit: DisplayUnit): string {
  const parts = [`${change.label}: tonight ${formatRawByUnit(change.tonight, unit)}`];
  if (change.lastNight != null) {
    parts.push(`last night ${formatRawByUnit(change.lastNight, unit)}`);
  }
  if (change.proposed != null && change.proposed !== change.tonight) {
    parts.push(`proposed ${formatRawByUnit(change.proposed, unit)}`);
  }
  return parts.join(", ");
}
