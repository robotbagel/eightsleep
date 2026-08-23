"use client";
import React, { useId } from "react";
import { paddedDomain, smoothPath, type Point } from "./chartUtils";

/**
 * One series, no axes, no legend — a shape next to a number. Used inside stat
 * tiles where the value is the headline and the line only says "and it moved
 * like this".
 */
export const Sparkline: React.FC<{
  series: Point[];
  color?: string;
  height?: number;
  fill?: boolean;
}> = ({ series, color = "var(--accent)", height = 30, fill = true }) => {
  const gradientId = useId().replace(/:/g, "");
  if (series.length < 2) return null;

  const W = 100;
  const sorted = series.slice().sort((a, b) => a[0] - b[0]);
  const t0 = sorted[0]![0];
  const t1 = sorted[sorted.length - 1]![0];
  const [lo, hi] = paddedDomain(sorted.map(([, v]) => v), 0.2);
  const span = t1 - t0 || 1;
  const points = sorted.map(([t, v]) => ({
    x: ((t - t0) / span) * W,
    y: height - ((v - lo) / (hi - lo || 1)) * height,
  }));
  const path = smoothPath(points);
  const last = points[points.length - 1]!;

  return (
    <svg
      viewBox={`0 0 ${W} ${height}`}
      preserveAspectRatio="none"
      className="mt-1 h-[30px] w-full"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.3" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {fill && (
        <path
          d={`${path} L ${W} ${height} L 0 ${height} Z`}
          fill={`url(#${gradientId})`}
        />
      )}
      <path
        d={path}
        className="draw-line"
        style={{ "--len": 300 } as React.CSSProperties}
        fill="none"
        stroke={color}
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
      <circle cx={last.x} cy={last.y} r="2" fill={color} />
    </svg>
  );
};
