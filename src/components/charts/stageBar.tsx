"use client";
import React from "react";
import {
  formatHours,
  STAGE_LABEL,
  STAGE_ORDER,
  STAGE_VAR,
  type StageKey,
} from "./chartUtils";

/**
 * How the night divided into stages. A single stacked bar because the parts
 * sum to a meaningful whole; 2px surface gaps between segments so adjacent
 * colours never touch, and every segment is direct-labelled below so identity
 * is never carried by colour alone.
 */
export const StageBar: React.FC<{
  stageHours: Record<string, number>;
  compact?: boolean;
}> = ({ stageHours, compact = false }) => {
  const present = STAGE_ORDER.filter((stage) => (stageHours[stage] ?? 0) > 0);
  const total = present.reduce((sum, s) => sum + (stageHours[s] ?? 0), 0);
  if (total <= 0) return null;

  return (
    <div>
      <div
        className="flex h-3 w-full gap-[2px] overflow-hidden rounded-full"
        role="img"
        aria-label={present
          .map((s) => `${STAGE_LABEL[s]} ${formatHours(stageHours[s])}`)
          .join(", ")}
      >
        {present.map((stage, index) => (
          <div
            key={stage}
            className="grow-seg h-full rounded-full"
            style={
              {
                width: `${((stageHours[stage] ?? 0) / total) * 100}%`,
                backgroundColor: STAGE_VAR[stage],
                "--i": index,
              } as React.CSSProperties
            }
          />
        ))}
      </div>

      <div
        className={
          compact
            ? "mt-2 flex flex-wrap gap-x-3 gap-y-1"
            : "mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 sm:grid-cols-4"
        }
      >
        {present.map((stage) => (
          <StageLegendItem
            key={stage}
            stage={stage}
            hours={stageHours[stage] ?? 0}
            share={(stageHours[stage] ?? 0) / total}
            compact={compact}
          />
        ))}
      </div>
    </div>
  );
};

const StageLegendItem: React.FC<{
  stage: StageKey;
  hours: number;
  share: number;
  compact: boolean;
}> = ({ stage, hours, share, compact }) => (
  <div className={compact ? "flex items-center gap-1.5" : ""}>
    <div className="flex items-center gap-1.5">
      <span
        className="inline-block h-2 w-2 shrink-0 rounded-full"
        style={{ backgroundColor: STAGE_VAR[stage] }}
      />
      <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
        {STAGE_LABEL[stage]}
      </span>
    </div>
    <div
      className={
        compact
          ? "tabular text-[11px] font-semibold"
          : "tabular ml-3.5 text-[13px] font-semibold"
      }
      style={{ color: "var(--text-headline)" }}
    >
      {formatHours(hours)}
      <span
        className="ml-1 text-[11px] font-normal"
        style={{ color: "var(--text-faint)" }}
      >
        {Math.round(share * 100)}%
      </span>
    </div>
  </div>
);
