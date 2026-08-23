"use client";
import React, { useState } from "react";
import {
  celsiusToRaw,
  formatLevelScale,
  rawToLevel,
  type DisplayUnit,
} from "~/lib/temperature";

interface StageMeta {
  key: "initial" | "deep" | "mid" | "final";
  name: string;
  feel: string;
  bandC: [number, number];
  science: string;
}

const STAGES: StageMeta[] = [
  {
    key: "initial",
    name: "Initial — sleep onset",
    feel: "Comfortably warm",
    bandC: [28, 30],
    science:
      "Mild warmth at bedtime helps your skin release core heat, which is what makes you fall asleep faster.",
  },
  {
    key: "deep",
    name: "Deep — slow-wave sleep",
    feel: "Coolest of the night",
    bandC: [25, 27],
    science:
      "Your core temperature must drop for deep sleep; a cool bed in the first hours measurably increases it.",
  },
  {
    key: "mid",
    name: "Middle of the night",
    feel: "Cool, a touch above deep",
    bandC: [26, 28],
    science:
      "Eases back toward neutral as deep-sleep pressure fades and your body reaches its natural low point (about 2h before waking).",
  },
  {
    key: "final",
    name: "Final — REM and wake-up",
    feel: "Gently warm",
    bandC: [28, 30],
    science:
      "In REM your body stops regulating its own temperature, so gentle warmth protects REM and makes waking easier.",
  },
];

interface Props {
  bedTime: string; // "HH:MM"
  wakeupTime: string; // "HH:MM"
  temps: { initial: number; deep: number; mid: number; final: number }; // °C
  displayUnit: DisplayUnit;
}

function minutesOf(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

export const TemperatureCurve: React.FC<Props> = ({
  bedTime,
  wakeupTime,
  temps,
  displayUnit,
}) => {
  const [selected, setSelected] = useState<StageMeta["key"] | null>(null);

  const fmt = (celsius: number): string =>
    displayUnit === "level"
      ? formatLevelScale(rawToLevel(celsiusToRaw(celsius)))
      : `${Math.round(celsius * 10) / 10}°C`;

  const bed = minutesOf(bedTime);
  let duration = minutesOf(wakeupTime) - bed;
  if (duration <= 0) duration += 24 * 60;
  if (duration < 240) return null;

  // Stage windows in minutes since bedtime (deep clamped for short nights).
  const finalStart = duration - 120;
  const deepEnd = Math.min(180, finalStart);
  const segments = [
    { meta: STAGES[0]!, start: 0, end: 60, temp: temps.initial },
    { meta: STAGES[1]!, start: 60, end: deepEnd, temp: temps.deep },
    { meta: STAGES[2]!, start: deepEnd, end: finalStart, temp: temps.mid },
    { meta: STAGES[3]!, start: finalStart, end: duration, temp: temps.final },
  ];

  const W = 320;
  const H = 116;
  const PAD_TOP = 8;
  const PAD_BOTTOM = 6;
  const allTemps = segments.map((s) => s.temp);
  const bandLo = Math.min(...STAGES.map((s) => s.bandC[0]));
  const bandHi = Math.max(...STAGES.map((s) => s.bandC[1]));
  const yMin = Math.min(...allTemps, bandLo) - 1;
  const yMax = Math.max(...allTemps, bandHi) + 1;
  const x = (minutes: number) => (minutes / duration) * W;
  const y = (celsius: number) =>
    PAD_TOP + ((yMax - celsius) / (yMax - yMin)) * (H - PAD_TOP - PAD_BOTTOM);

  // Plateau line per stage with a short S-curve at each transition.
  const EASE = 10;
  let path = `M ${x(0)} ${y(segments[0]!.temp)}`;
  segments.forEach((segment, index) => {
    const xEnd = x(segment.end);
    path += ` L ${index === segments.length - 1 ? xEnd : xEnd - EASE} ${y(segment.temp)}`;
    const next = segments[index + 1];
    if (next) {
      path += ` C ${xEnd} ${y(segment.temp)}, ${xEnd} ${y(next.temp)}, ${xEnd + EASE} ${y(next.temp)}`;
    }
  });

  const timeAt = (minutesAfterBed: number): string => {
    const total = (bed + minutesAfterBed) % (24 * 60);
    const h = Math.floor(total / 60);
    const m = total % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  };

  const selectedSegment = segments.find((s) => s.meta.key === selected);

  return (
    <div
      className="rounded-xl border p-3"
      style={{
        borderColor: "var(--border)",
        backgroundColor: "var(--surface-sunken)",
      }}
    >
      <p className="mb-2 text-xs" style={{ color: "var(--text-muted)" }}>
        Warm to fall asleep, coolest for deep sleep, easing back, gently warm
        before waking. Tap a dot for what each stage is doing.
      </p>

      <div className="relative w-full" style={{ aspectRatio: `${W} / ${H}` }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="absolute inset-0 h-full w-full"
        role="img"
        aria-label="Your planned bed temperature across the night"
      >
        <defs>
          <linearGradient id="curveFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.22" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Recommended band per stage — the target you are aiming inside of. */}
        {segments.map((segment) => (
          <rect
            key={`band-${segment.meta.key}`}
            x={x(segment.start)}
            width={x(segment.end) - x(segment.start)}
            y={y(segment.meta.bandC[1])}
            height={y(segment.meta.bandC[0]) - y(segment.meta.bandC[1])}
            fill="var(--success)"
            opacity="0.14"
          />
        ))}

        <path
          d={`${path} L ${W} ${H - PAD_BOTTOM} L 0 ${H - PAD_BOTTOM} Z`}
          fill="url(#curveFill)"
        />
        <path
          d={path}
          className="draw-line"
          style={{ "--len": 700 } as React.CSSProperties}
          fill="none"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          stroke="var(--accent)"
        />

        {segments.map((segment) => {
          const cx = x((segment.start + segment.end) / 2);
          const cy = y(segment.temp);
          const isSelected = selected === segment.meta.key;
          const inBand =
            segment.temp >= segment.meta.bandC[0] &&
            segment.temp <= segment.meta.bandC[1];
          return (
            <g
              key={`dot-${segment.meta.key}`}
              onClick={() => setSelected(isSelected ? null : segment.meta.key)}
              className="cursor-pointer"
              role="button"
              tabIndex={0}
              aria-label={`${segment.meta.name}, ${fmt(segment.temp)}`}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setSelected(isSelected ? null : segment.meta.key);
                }
              }}
            >
              <circle cx={cx} cy={cy} r="14" fill="transparent" />
              <circle
                cx={cx}
                cy={cy}
                r={isSelected ? 7 : 5.5}
                fill={inBand ? "var(--accent)" : "var(--warning)"}
                stroke="var(--surface-sunken)"
                strokeWidth="2.5"
                className="transition-[r] duration-fast ease-snap"
              />
            </g>
          );
        })}

      </svg>
      </div>

      <div
        className="tabular mt-1 flex justify-between text-[10px]"
        style={{ color: "var(--text-faint)" }}
      >
        <span>{bedTime}</span>
        <span>
          {fmt(yMin + 1)} – {fmt(yMax - 1)}
        </span>
        <span>{wakeupTime}</span>
      </div>

      {selectedSegment ? (
        <div
          className="mt-1 rounded-lg p-3"
          style={{ backgroundColor: "var(--surface)" }}
        >
          <div className="flex items-baseline justify-between gap-2">
            <span
              className="text-sm font-semibold"
              style={{ color: "var(--text-headline)" }}
            >
              {selectedSegment.meta.name}
            </span>
            <span className="tabular text-xs" style={{ color: "var(--text-faint)" }}>
              {timeAt(selectedSegment.start)}–{timeAt(selectedSegment.end)}
            </span>
          </div>
          <p className="mt-1.5 text-xs" style={{ color: "var(--text-muted)" }}>
            Feel: <span className="font-medium">{selectedSegment.meta.feel}</span>{" "}
            · target {fmt(selectedSegment.meta.bandC[0])} to{" "}
            {fmt(selectedSegment.meta.bandC[1])} · yours{" "}
            <span
              className="font-semibold"
              style={{
                color:
                  selectedSegment.temp >= selectedSegment.meta.bandC[0] &&
                  selectedSegment.temp <= selectedSegment.meta.bandC[1]
                    ? "var(--success)"
                    : "var(--warning)",
              }}
            >
              {fmt(selectedSegment.temp)}
            </span>
          </p>
          <p className="mt-1.5 text-xs" style={{ color: "var(--text-muted)" }}>
            {selectedSegment.meta.science}
          </p>
        </div>
      ) : (
        <p className="text-[11px]" style={{ color: "var(--text-faint)" }}>
          Room rule of thumb: above 24°C shift the whole curve about 1°C cooler,
          below 18°C about 1°C warmer. An amber dot sits outside the target band.
        </p>
      )}
    </div>
  );
};
