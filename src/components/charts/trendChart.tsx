"use client";
import React, { useState } from "react";
import {
  formatHours,
  scoreTone,
  shortDate,
  TONE_VAR,
  weekdayLetter,
} from "./chartUtils";

export interface TrendNight {
  date: string;
  score: number | null;
  sleepDurationHours: number | null;
  restingHeartRate: number | null;
  hrv: number | null;
}

/**
 * Last N nights. Bars, because the job is comparing discrete nights, and the
 * y-axis starts at 0 (no exceptions). Colour encodes the score band, which is
 * also stated in the tooltip and the summary line, so it never carries meaning
 * alone.
 */
export const TrendChart: React.FC<{
  nights: TrendNight[];
  goalHours?: number;
}> = ({ nights, goalHours = 8 }) => {
  const [active, setActive] = useState<number | null>(null);
  if (nights.length === 0) return null;

  const shown = nights.slice(-10);
  const best = Math.max(...shown.map((n) => n.score ?? 0), 100);
  const average =
    shown.filter((n) => n.score != null).length > 0
      ? Math.round(
          shown.reduce((sum, n) => sum + (n.score ?? 0), 0) /
            shown.filter((n) => n.score != null).length,
        )
      : null;
  const hovered = active != null ? shown[active] : null;

  return (
    <div>
      <div className="mb-3 flex items-baseline justify-between">
        <span className="text-sm" style={{ color: "var(--text-muted)" }}>
          {hovered ? shortDate(hovered.date) : `${shown.length}-night average`}
        </span>
        <span
          className="tabular text-lg font-semibold"
          style={{ color: "var(--text-headline)" }}
        >
          {hovered ? (hovered.score ?? "—") : (average ?? "—")}
          <span
            className="ml-1 text-xs font-normal"
            style={{ color: "var(--text-faint)" }}
          >
            {hovered ? formatHours(hovered.sleepDurationHours) : "/100"}
          </span>
        </span>
      </div>

      <div
        className="flex h-28 items-end gap-1.5"
        onMouseLeave={() => setActive(null)}
      >
        {shown.map((night, index) => {
          const tone = scoreTone(night.score);
          const height = Math.max(((night.score ?? 0) / best) * 100, 3);
          const isActive = active === index;
          return (
            <button
              key={night.date}
              type="button"
              className="group flex h-full flex-1 cursor-pointer flex-col justify-end rounded-md focus-visible:outline-none"
              onMouseEnter={() => setActive(index)}
              onFocus={() => setActive(index)}
              onBlur={() => setActive(null)}
              aria-label={`${shortDate(night.date)}: score ${night.score ?? "not available"}, ${formatHours(night.sleepDurationHours)} asleep`}
            >
              <span
                className="grow-bar block w-full rounded-t-md transition-[opacity,filter] duration-fast ease-snap"
                style={
                  {
                    height: `${height}%`,
                    backgroundColor: TONE_VAR[tone],
                    opacity: active == null || isActive ? 1 : 0.42,
                    "--i": index,
                  } as React.CSSProperties
                }
              />
            </button>
          );
        })}
      </div>

      <div className="mt-1.5 flex gap-1.5">
        {shown.map((night, index) => (
          <span
            key={night.date}
            className="flex-1 text-center text-[10px]"
            style={{
              color:
                active === index ? "var(--text)" : "var(--text-faint)",
            }}
          >
            {weekdayLetter(night.date).slice(0, 2)}
          </span>
        ))}
      </div>

      <DurationRow nights={shown} goalHours={goalHours} active={active} />
    </div>
  );
};

const DurationRow: React.FC<{
  nights: TrendNight[];
  goalHours: number;
  active: number | null;
}> = ({ nights, goalHours, active }) => {
  const max =
    Math.max(goalHours, ...nights.map((n) => n.sleepDurationHours ?? 0)) * 1.08;
  return (
    <div className="mt-4">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
          Time asleep
        </span>
        <span className="text-[11px]" style={{ color: "var(--text-faint)" }}>
          goal {goalHours}h
        </span>
      </div>
      <div className="relative flex h-14 items-end gap-1.5">
        <span
          className="pointer-events-none absolute left-0 right-0 border-t border-dashed"
          style={{
            bottom: `${(goalHours / max) * 100}%`,
            borderColor: "var(--border-strong)",
          }}
        />
        {nights.map((night, index) => (
          <span
            key={night.date}
            className="grow-bar block flex-1 rounded-t-[3px] transition-opacity duration-fast ease-snap"
            style={
              {
                height: `${Math.max(((night.sleepDurationHours ?? 0) / max) * 100, 3)}%`,
                backgroundColor: "var(--accent)",
                opacity:
                  (active != null && active !== index
                    ? 0.35
                    : (night.sleepDurationHours ?? 0) >= goalHours
                      ? 1
                      : 0.55),
                "--i": index,
              } as React.CSSProperties
            }
          />
        ))}
      </div>
      <p className="mt-1.5 text-[10px]" style={{ color: "var(--text-faint)" }}>
        Solid bars cleared the goal.
      </p>
    </div>
  );
};
