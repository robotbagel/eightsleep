"use client";
import React, { useEffect, useRef, useState } from "react";
import { rawToCelsius } from "~/lib/temperature";

export interface PlanLevels {
  initial: number | null;
  deep: number | null;
  mid: number | null;
  final: number | null;
}

export type PlanSeriesKey = "lastNight" | "tonight" | "proposed";

export interface PlanSeries {
  key: PlanSeriesKey;
  label: string;
  levels: PlanLevels; // raw Eight Sleep levels
  color: string;
  dashed?: boolean;
  emphasis?: boolean;
}

const STAGE_ORDER = ["initial", "deep", "mid", "final"] as const;

/**
 * Last night, tonight and (when it exists) the not-yet-applied proposal, on
 * one shared °C axis. Three plateaus per series across the four stages, so the
 * question "did the AI actually change anything, or am I looking at
 * yesterday's numbers?" is answered by the shape.
 *
 * Drawn at 1:1 CSS pixels (ResizeObserver) so stroke weights hold at any card
 * width; all text is HTML for the same reason.
 */
export const PlanCurve: React.FC<{
  series: PlanSeries[];
  bedTime?: string;
  wakeupTime?: string;
}> = ({ series, bedTime, wakeupTime }) => {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [W, setW] = useState(360);
  const H = 116;

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry?.contentRect.width ?? 0;
      if (width > 0) setW(Math.round(width));
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  const usable = series.filter((s) =>
    STAGE_ORDER.some((stage) => s.levels[stage] != null),
  );
  if (usable.length === 0) return null;

  const values = usable.flatMap((s) =>
    STAGE_ORDER.map((stage) => s.levels[stage]).filter(
      (v): v is number => v != null,
    ),
  ).map(rawToCelsius);
  const lo = Math.min(...values) - 1.2;
  const hi = Math.max(...values) + 1.2;

  const GUTTER = 30;
  const PAD = 10;
  const plotW = W - GUTTER - 6;
  const segW = plotW / 4;
  const y = (celsius: number) =>
    PAD + ((hi - celsius) / (hi - lo || 1)) * (H - PAD * 2);

  const pathFor = (levels: PlanLevels): string => {
    const EASE = Math.min(12, segW * 0.22);
    let d = "";
    let previousY: number | null = null;
    STAGE_ORDER.forEach((stage, index) => {
      const level = levels[stage];
      if (level == null) {
        previousY = null;
        return;
      }
      const yy = y(rawToCelsius(level));
      const x0 = GUTTER + index * segW;
      const x1 = x0 + segW;
      if (previousY == null) {
        d += `M ${x0.toFixed(1)} ${yy.toFixed(1)}`;
      } else {
        d += ` C ${x0.toFixed(1)} ${previousY.toFixed(1)}, ${x0.toFixed(1)} ${yy.toFixed(1)}, ${(x0 + EASE).toFixed(1)} ${yy.toFixed(1)}`;
      }
      d += ` L ${x1.toFixed(1)} ${yy.toFixed(1)}`;
      previousY = yy;
    });
    return d;
  };

  return (
    <div>
      <div ref={boxRef} className="relative w-full" style={{ height: H }}>
        {[hi - 1.2, lo + 1.2].map((value, i) => (
          <span
            key={i}
            className="tabular absolute -translate-y-1/2 text-[10px]"
            style={{
              left: 0,
              top: `${(y(value) / H) * 100}%`,
              color: "var(--text-faint)",
            }}
          >
            {value.toFixed(0)}°
          </span>
        ))}

        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="absolute inset-0 h-full w-full"
          role="img"
          aria-label={`Bed temperature plan across the night: ${usable.map((s) => s.label).join(", ")}`}
        >
          {STAGE_ORDER.map((stage, index) => (
            <line
              key={stage}
              x1={GUTTER + index * segW}
              x2={GUTTER + index * segW}
              y1={4}
              y2={H - 4}
              stroke="var(--border)"
              strokeWidth="1"
            />
          ))}

          {usable.map((s) => (
            <path
              key={s.key}
              d={pathFor(s.levels)}
              fill="none"
              stroke={s.color}
              strokeWidth={s.emphasis ? 2.5 : 1.75}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeDasharray={s.dashed ? "5 4" : undefined}
              opacity={s.emphasis ? 1 : 0.85}
            />
          ))}

          {usable
            .filter((s) => s.emphasis)
            .map((s) =>
              STAGE_ORDER.map((stage, index) => {
                const level = s.levels[stage];
                if (level == null) return null;
                return (
                  <circle
                    key={`${s.key}-${stage}`}
                    cx={GUTTER + index * segW + segW / 2}
                    cy={y(rawToCelsius(level))}
                    r="4"
                    fill={s.color}
                    stroke="var(--surface)"
                    strokeWidth="2"
                  />
                );
              }),
            )}
        </svg>
      </div>

      <div className="relative mt-1 flex" style={{ paddingLeft: GUTTER }}>
        {["Onset", "Deep", "Middle", "REM"].map((label) => (
          <span
            key={label}
            className="flex-1 text-center text-[10px]"
            style={{ color: "var(--text-faint)" }}
          >
            {label}
          </span>
        ))}
      </div>

      {(bedTime ?? wakeupTime) && (
        <div
          className="tabular mt-0.5 flex justify-between text-[10px]"
          style={{ color: "var(--text-faint)", paddingLeft: GUTTER }}
        >
          <span>{bedTime}</span>
          <span>{wakeupTime}</span>
        </div>
      )}

      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
        {usable.map((s) => (
          <span
            key={s.key}
            className="flex items-center gap-1.5"
            style={{ color: "var(--text-muted)" }}
          >
            <span
              className="inline-block h-[2px] w-4 rounded-full"
              style={{
                backgroundColor: s.dashed ? "transparent" : s.color,
                backgroundImage: s.dashed
                  ? `repeating-linear-gradient(90deg, ${s.color} 0 4px, transparent 4px 8px)`
                  : undefined,
              }}
            />
            {s.label}
          </span>
        ))}
      </div>
    </div>
  );
};
