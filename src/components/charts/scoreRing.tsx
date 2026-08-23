"use client";
import React from "react";
import { scoreTone, TONE_VAR } from "./chartUtils";
import { useCountUp } from "./useCountUp";

/**
 * The one hero number on the page. A ring rather than a bar because it is a
 * single value out of a fixed maximum, and the arc gives the count-up
 * something to travel along.
 */
export const ScoreRing: React.FC<{
  score: number | null;
  size?: number;
  label?: string;
}> = ({ score, size = 132, label }) => {
  const animated = useCountUp(score, 900);
  const tone = scoreTone(score);
  const stroke = 9;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const fraction = Math.max(0, Math.min(animated / 100, 1));

  return (
    <div
      className="relative shrink-0"
      style={{ width: size, height: size }}
      role="img"
      aria-label={
        score == null ? "No sleep score yet" : `Sleep score ${score} out of 100`
      }
    >
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--surface-sunken)"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={TONE_VAR[tone]}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - fraction)}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span
          className="tabular font-semibold leading-none"
          style={{
            fontSize: size * 0.29,
            color: score == null ? "var(--text-faint)" : "var(--text-headline)",
          }}
        >
          {score == null ? "—" : Math.round(animated)}
        </span>
        <span
          className="mt-1 text-[11px] font-medium uppercase tracking-wider"
          style={{ color: "var(--text-muted)" }}
        >
          {label ?? "score"}
        </span>
      </div>
    </div>
  );
};
