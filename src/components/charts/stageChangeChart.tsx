"use client";
import React from "react";
import { formatRawByUnit, rawToCelsius, type DisplayUnit } from "~/lib/temperature";

export interface StageChange {
  label: string;
  previous: number; // raw level
  recommended: number; // raw level
}

/**
 * A dumbbell per stage: where the bed was, where the AI wants it, on one shared
 * temperature axis so the size and direction of every change is readable at a
 * glance instead of being four lines of "27.5 → 26.5".
 */
export const StageChangeChart: React.FC<{
  changes: StageChange[];
  unit: DisplayUnit;
}> = ({ changes, unit }) => {
  if (changes.length === 0) return null;

  const values = changes.flatMap((c) => [
    rawToCelsius(c.previous),
    rawToCelsius(c.recommended),
  ]);
  const lo = Math.min(...values) - 1;
  const hi = Math.max(...values) + 1;
  const position = (raw: number) =>
    ((rawToCelsius(raw) - lo) / (hi - lo || 1)) * 100;

  return (
    <div className="space-y-2.5">
      {changes.map((change, index) => {
        const from = position(change.previous);
        const to = position(change.recommended);
        const changed = change.previous !== change.recommended;
        const cooler = change.recommended < change.previous;
        const moveColor = cooler ? "var(--cool)" : "var(--warm)";

        return (
          <div
            key={change.label}
            className="enter"
            style={{ "--i": index } as React.CSSProperties}
          >
            <div className="mb-1 flex items-baseline justify-between">
              <span className="text-xs" style={{ color: "var(--text-muted)" }}>
                {change.label}
              </span>
              <span
                className="tabular text-xs font-semibold"
                style={{
                  color: changed ? moveColor : "var(--text-faint)",
                }}
              >
                {changed ? (
                  <>
                    <span style={{ color: "var(--text-faint)" }}>
                      {formatRawByUnit(change.previous, unit)}
                    </span>
                    <span className="mx-1" aria-hidden="true">
                      →
                    </span>
                    {formatRawByUnit(change.recommended, unit)}
                  </>
                ) : (
                  <>{formatRawByUnit(change.previous, unit)} · unchanged</>
                )}
              </span>
            </div>

            <div
              className="relative h-4"
              role="img"
              aria-label={
                changed
                  ? `${change.label}: ${formatRawByUnit(change.previous, unit)} to ${formatRawByUnit(change.recommended, unit)}, ${cooler ? "cooler" : "warmer"}`
                  : `${change.label}: unchanged at ${formatRawByUnit(change.previous, unit)}`
              }
            >
              <span
                className="absolute left-0 right-0 top-1/2 h-[3px] -translate-y-1/2 rounded-full"
                style={{ backgroundColor: "var(--surface-sunken)" }}
              />
              {changed && (
                <span
                  className="grow-seg absolute top-1/2 h-[3px] -translate-y-1/2 rounded-full"
                  style={
                    {
                      left: `${Math.min(from, to)}%`,
                      width: `${Math.abs(to - from)}%`,
                      backgroundColor: moveColor,
                      "--i": index,
                    } as React.CSSProperties
                  }
                />
              )}
              <span
                className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2"
                style={{
                  left: `${from}%`,
                  borderColor: "var(--border-strong)",
                  backgroundColor: "var(--surface)",
                }}
              />
              <span
                className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 transition-transform duration-base ease-snap"
                style={{
                  left: `${to}%`,
                  backgroundColor: changed ? moveColor : "var(--text-faint)",
                  borderColor: "var(--surface)",
                }}
              />
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
