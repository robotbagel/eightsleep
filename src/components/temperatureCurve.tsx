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
  const H = 110;
  const PAD_TOP = 8;
  const PAD_BOTTOM = 18;
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

  const selectedMeta = segments.find((s) => s.meta.key === selected);

  return (
    <div className="rounded-md bg-gray-50 p-3">
      <p className="mb-1 text-xs text-gray-600">
        The research-backed shape: warm to fall asleep, coolest for deep sleep,
        easing back, gently warm before waking. Tap a dot for stage advice.
      </p>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        role="img"
        aria-label="Night temperature curve"
      >
        {/* Recommended band per stage */}
        {segments.map((segment) => (
          <rect
            key={`band-${segment.meta.key}`}
            x={x(segment.start)}
            width={x(segment.end) - x(segment.start)}
            y={y(segment.meta.bandC[1])}
            height={y(segment.meta.bandC[0]) - y(segment.meta.bandC[1])}
            className="fill-green-200/50"
          />
        ))}
        <path
          d={path}
          fill="none"
          strokeWidth="2.5"
          className="stroke-indigo-600"
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
              onClick={() =>
                setSelected(isSelected ? null : segment.meta.key)
              }
              className="cursor-pointer"
            >
              <circle cx={cx} cy={cy} r="13" fill="transparent" />
              <circle
                cx={cx}
                cy={cy}
                r={isSelected ? 7 : 5.5}
                className={
                  inBand ? "fill-indigo-600" : "fill-amber-500"
                }
                stroke="white"
                strokeWidth="2"
              />
            </g>
          );
        })}
        <text x={2} y={H - 4} className="fill-gray-500 text-[9px]">
          {bedTime}
        </text>
        <text x={W - 2} y={H - 4} textAnchor="end" className="fill-gray-500 text-[9px]">
          {wakeupTime}
        </text>
      </svg>

      {selectedMeta ? (
        <div className="mt-1 rounded-md bg-white p-3 shadow-sm">
          <div className="flex items-baseline justify-between">
            <span className="text-sm font-semibold text-gray-800">
              {selectedMeta.meta.name}
            </span>
            <span className="text-xs text-gray-500">
              {timeAt(selectedMeta.start)}–{timeAt(selectedMeta.end)}
            </span>
          </div>
          <p className="mt-1 text-xs text-gray-700">
            Feel: <span className="font-medium">{selectedMeta.meta.feel}</span>{" "}
            · Recommended {fmt(selectedMeta.meta.bandC[0])} to{" "}
            {fmt(selectedMeta.meta.bandC[1])} · Yours:{" "}
            <span
              className={
                selectedMeta.temp >= selectedMeta.meta.bandC[0] &&
                selectedMeta.temp <= selectedMeta.meta.bandC[1]
                  ? "font-medium text-green-700"
                  : "font-medium text-amber-600"
              }
            >
              {fmt(selectedMeta.temp)}
            </span>
          </p>
          <p className="mt-1 text-xs text-gray-600">{selectedMeta.meta.science}</p>
        </div>
      ) : (
        <p className="text-[11px] text-gray-500">
          Room rule of thumb: above 24°C shift the whole curve about 1°C
          cooler; below 18°C about 1°C warmer. Amber dot = outside the
          recommended band.
        </p>
      )}
    </div>
  );
};
