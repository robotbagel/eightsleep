"use client";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  clamp,
  clockIn,
  hourTicks,
  isStageKey,
  paddedDomain,
  smoothPath,
  STAGE_LABEL,
  STAGE_ORDER,
  STAGE_VAR,
  type Point,
  type StageKey,
} from "./chartUtils";

export interface NightEvent {
  at: number;
  label: string;
  detail?: string;
  source: "schedule" | "live" | "off" | "manual";
}

interface Props {
  timezone: string;
  /** Session start — where the hypnogram runs begin. */
  sessionStart: number | null;
  sleepStart: number | null;
  sleepEnd: number | null;
  stages: { stage: string; duration: number }[];
  bed: Point[];
  room: Point[];
  tosses: number[];
  events: NightEvent[];
}

// Geometry. One viewBox, three stacked panels sharing the same time axis —
// small multiples, never a second y-scale on one plot.
//
// The viewBox width tracks the measured container width so the chart draws at
// 1:1 CSS pixels: stroke weights and block heights stay constant from a 375px
// phone to a 1280px desktop instead of being scaled up with the box.
const GUTTER = 34;
const X0 = GUTTER;

/** Vertical geometry grows a little with the card so a wide desktop chart does
 *  not look like a letterbox, while a 375px phone stays compact. */
function layoutFor(width: number) {
  const k = Math.min(Math.max(width / 420, 1), 1.7);
  const LANE_TOP = 8;
  const LANE_H = Math.round(22 * k);
  const BLOCK_H = Math.round(14 * k);
  const TEMP_TOP = LANE_TOP + LANE_H * 4 + Math.round(18 * k);
  const TEMP_H = Math.round(76 * k);
  const RAIL_TOP = TEMP_TOP + TEMP_H + Math.round(14 * k);
  const RAIL_H = Math.round(16 * k);
  return {
    LANE_TOP,
    LANE_H,
    BLOCK_H,
    TEMP_TOP,
    TEMP_H,
    RAIL_TOP,
    RAIL_H,
    H: RAIL_TOP + RAIL_H + 2,
  };
}

const SOURCE_COLOR: Record<NightEvent["source"], string> = {
  schedule: "var(--accent)",
  live: "var(--warm)",
  off: "var(--text-faint)",
  // The one mark on this chart the sleeper made themselves. It gets its own
  // colour because reading it as an app action is exactly the mistake that
  // made hand adjustments invisible.
  manual: "var(--cool)",
};

export const NightChart: React.FC<Props> = ({
  timezone,
  sessionStart,
  sleepStart,
  sleepEnd,
  stages,
  bed,
  room,
  tosses,
  events,
}) => {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const [W, setW] = useState(360);

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

  const X1 = W - 6;
  const { LANE_TOP, LANE_H, BLOCK_H, TEMP_TOP, TEMP_H, RAIL_TOP, RAIL_H, H } =
    layoutFor(W);

  const model = useMemo(() => {
    // ---- time domain -----------------------------------------------------
    const candidates: number[] = [];
    if (sessionStart != null) candidates.push(sessionStart);
    if (sleepStart != null) candidates.push(sleepStart);
    if (sleepEnd != null) candidates.push(sleepEnd);
    for (const [t] of bed) candidates.push(t);
    for (const [t] of room) candidates.push(t);
    for (const t of tosses) candidates.push(t);
    for (const e of events) candidates.push(e.at);
    if (candidates.length < 2) return null;
    const t0 = Math.min(...candidates);
    const t1 = Math.max(...candidates);
    if (t1 - t0 < 60_000) return null;

    const x = (t: number) => X0 + ((t - t0) / (t1 - t0)) * (X1 - X0);

    // ---- hypnogram runs --------------------------------------------------
    type Run = { stage: StageKey; from: number; to: number };
    const runs: Run[] = [];
    let cursorMs = sessionStart ?? sleepStart ?? t0;
    for (const run of stages) {
      const from = cursorMs;
      const to = cursorMs + run.duration * 1000;
      cursorMs = to;
      const key = run.stage.toLowerCase();
      if (isStageKey(key)) runs.push({ stage: key, from, to });
      // "out" (out of bed) leaves a deliberate gap in the band.
    }

    // ---- temperature series ---------------------------------------------
    const tempValues = [...bed, ...room].map(([, v]) => v);
    const [lo, hi] = paddedDomain(tempValues, 0.18);
    const y = (value: number) =>
      TEMP_TOP + TEMP_H - ((clamp(value, lo, hi) - lo) / (hi - lo)) * TEMP_H;

    const toPoints = (series: Point[]) =>
      series
        .slice()
        .sort((a, b) => a[0] - b[0])
        .map(([t, v]) => ({ x: x(t), y: y(v) }));

    const bedPoints = toPoints(bed);
    const roomPoints = toPoints(room);

    return {
      t0,
      t1,
      x,
      y,
      lo,
      hi,
      runs,
      bedPoints,
      roomPoints,
      bedPath: smoothPath(bedPoints),
      roomPath: smoothPath(roomPoints),
      ticks: hourTicks(t0, t1, t1 - t0 > 9 * 3_600_000 ? 2 : 1),
    };
  }, [
    sessionStart,
    sleepStart,
    sleepEnd,
    stages,
    bed,
    room,
    tosses,
    events,
    X1,
    TEMP_TOP,
    TEMP_H,
  ]);

  if (!model) {
    return (
      <p className="py-6 text-center text-sm" style={{ color: "var(--text-muted)" }}>
        Not enough of the night recorded yet to draw it.
      </p>
    );
  }

  const { t0, t1, x, y, runs, bedPoints, bedPath, roomPath, ticks } = model;

  const readAt = (time: number) => {
    const nearest = (series: Point[]) => {
      if (series.length === 0) return null;
      let best = series[0]!;
      for (const point of series) {
        if (Math.abs(point[0] - time) < Math.abs(best[0] - time)) best = point;
      }
      return Math.abs(best[0] - time) < 90 * 60_000 ? best[1] : null;
    };
    const run = runs.find((r) => time >= r.from && time < r.to);
    return {
      stage: run?.stage ?? null,
      bed: nearest(bed),
      room: nearest(room),
    };
  };

  const handleMove = (clientX: number) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const ratio = (clientX - rect.left) / rect.width;
    const px = clamp(ratio * W, X0, X1);
    setCursor(t0 + ((px - X0) / (X1 - X0)) * (t1 - t0));
  };

  const reading = cursor == null ? null : readAt(cursor);
  const cursorX = cursor == null ? 0 : x(cursor);
  const tooltipLeft = clamp(((cursorX - X0) / (X1 - X0)) * 100, 6, 94);

  return (
    <div className="relative">
      <div ref={boxRef} className="relative w-full" style={{ height: H }}>
        {/* Lane labels live in HTML so they stay at a real type size however
            wide the card gets — SVG <text> scales with the viewBox. */}
        {STAGE_ORDER.map((stage, lane) => (
          <span
            key={`lbl-${stage}`}
            className="absolute -translate-y-1/2 text-[10px] font-semibold uppercase tracking-wide"
            style={{
              left: 0,
              width: `${(GUTTER / W) * 100}%`,
              top: `${((LANE_TOP + lane * LANE_H + BLOCK_H / 2) / H) * 100}%`,
              color: "var(--text-faint)",
            }}
          >
            {STAGE_LABEL[stage]}
          </span>
        ))}

        {/* Temperature scale endpoints, same reason. */}
        {[model.hi, model.lo].map((value, i) => (
          <span
            key={`ty-${i}`}
            className="tabular absolute -translate-y-1/2 text-[10px]"
            style={{
              left: 0,
              width: `${(GUTTER / W) * 100}%`,
              top: `${((i === 0 ? TEMP_TOP : TEMP_TOP + TEMP_H) / H) * 100}%`,
              color: "var(--text-faint)",
            }}
          >
            {value.toFixed(0)}°
          </span>
        ))}

      <svg
        ref={svgRef}
        className="absolute inset-0 h-full w-full"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="Sleep stages, bed temperature and temperature changes across the night"
        onMouseMove={(e) => handleMove(e.clientX)}
        onMouseLeave={() => setCursor(null)}
        onTouchStart={(e) => handleMove(e.touches[0]!.clientX)}
        onTouchMove={(e) => handleMove(e.touches[0]!.clientX)}
        onTouchEnd={() => setCursor(null)}
      >
        <defs>
          <linearGradient id="bedFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--warm)" stopOpacity="0.28" />
            <stop offset="100%" stopColor="var(--warm)" stopOpacity="0.02" />
          </linearGradient>
        </defs>

        {/* Hour gridlines run through every panel so the eye can read down. */}
        {ticks.map((t) => (
          <line
            key={`grid-${t}`}
            x1={x(t)}
            x2={x(t)}
            y1={LANE_TOP - 2}
            y2={RAIL_TOP + RAIL_H}
            stroke="var(--border)"
            strokeWidth="1"
          />
        ))}

        {/* ---- Panel 1: hypnogram ---------------------------------------- */}
        {STAGE_ORDER.map((stage, lane) => (
          <g key={`lane-${stage}`}>
            <line
              x1={X0}
              x2={X1}
              y1={LANE_TOP + lane * LANE_H + BLOCK_H / 2}
              y2={LANE_TOP + lane * LANE_H + BLOCK_H / 2}
              stroke="var(--border)"
              strokeWidth="1"
              strokeDasharray="1 4"
              opacity="0.7"
            />
          </g>
        ))}
        {runs.map((run, index) => {
          const lane = STAGE_ORDER.indexOf(run.stage);
          const left = x(run.from);
          const width = Math.max(x(run.to) - left, 1.5);
          return (
            <rect
              key={`run-${index}`}
              className="grow-seg"
              x={left}
              y={LANE_TOP + lane * LANE_H}
              width={width}
              height={BLOCK_H}
              rx={3}
              fill={STAGE_VAR[run.stage]}
              style={{ "--i": Math.min(index, 12) } as React.CSSProperties}
            />
          );
        })}

        {/* ---- Panel 2: temperature (both series in °C, one axis) -------- */}
        {roomPath && (
          <path
            d={roomPath}
            fill="none"
            stroke="var(--text-faint)"
            strokeWidth="1.5"
            strokeDasharray="3 3"
            strokeLinecap="round"
          />
        )}
        {bedPath && bedPoints.length > 1 && (
          <>
            <path
              d={`${bedPath} L ${bedPoints[bedPoints.length - 1]!.x} ${TEMP_TOP + TEMP_H} L ${bedPoints[0]!.x} ${TEMP_TOP + TEMP_H} Z`}
              fill="url(#bedFill)"
            />
            <path
              d={bedPath}
              className="draw-line"
              style={{ "--len": 900 } as React.CSSProperties}
              fill="none"
              stroke="var(--warm)"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </>
        )}

        {/* ---- Panel 3: what happened ------------------------------------ */}
        {tosses.map((t, index) => (
          <line
            key={`toss-${index}`}
            x1={x(t)}
            x2={x(t)}
            y1={RAIL_TOP + 4}
            y2={RAIL_TOP + RAIL_H}
            stroke="var(--stage-awake)"
            strokeWidth="1.5"
            strokeLinecap="round"
            opacity="0.75"
          />
        ))}
        {events.map((event, index) => (
          <g key={`event-${index}`}>
            <line
              x1={x(event.at)}
              x2={x(event.at)}
              y1={TEMP_TOP}
              y2={RAIL_TOP + RAIL_H / 2}
              stroke={SOURCE_COLOR[event.source]}
              strokeWidth="1"
              strokeDasharray="2 2"
              opacity="0.55"
            />
            <circle
              cx={x(event.at)}
              cy={RAIL_TOP + RAIL_H / 2}
              r="3.4"
              fill={SOURCE_COLOR[event.source]}
              stroke="var(--surface)"
              strokeWidth="1.5"
            />
          </g>
        ))}

        {/* ---- Crosshair ------------------------------------------------- */}
        {cursor != null && (
          <>
            <line
              x1={cursorX}
              x2={cursorX}
              y1={LANE_TOP - 2}
              y2={RAIL_TOP + RAIL_H}
              stroke="var(--text)"
              strokeWidth="1"
              opacity="0.55"
            />
            {reading?.bed != null && (
              <circle
                cx={cursorX}
                cy={y(reading.bed)}
                r="3.5"
                fill="var(--warm)"
                stroke="var(--surface)"
                strokeWidth="2"
              />
            )}
          </>
        )}
      </svg>
      </div>

      <div className="relative mt-1 h-4">
        {ticks.map((t) => (
          <span
            key={`tick-${t}`}
            className="tabular absolute -translate-x-1/2 text-[10px]"
            style={{ left: `${(x(t) / W) * 100}%`, color: "var(--text-faint)" }}
          >
            {clockIn(t, timezone)}
          </span>
        ))}
      </div>

      {cursor != null && reading && (
        <div
          className="pointer-events-none absolute -top-1 z-10 -translate-x-1/2 rounded-lg border px-2.5 py-1.5 text-[11px] shadow-pop"
          style={{
            left: `${tooltipLeft}%`,
            backgroundColor: "var(--surface-raised)",
            borderColor: "var(--border-strong)",
            color: "var(--text)",
          }}
        >
          <div
            className="tabular font-semibold"
            style={{ color: "var(--text-headline)" }}
          >
            {clockIn(cursor, timezone)}
          </div>
          {reading.stage && (
            <div className="mt-0.5 flex items-center gap-1.5">
              <span
                className="inline-block h-1.5 w-1.5 rounded-full"
                style={{ backgroundColor: STAGE_VAR[reading.stage] }}
              />
              {STAGE_LABEL[reading.stage]}
            </div>
          )}
          {reading.bed != null && (
            <div className="tabular mt-0.5" style={{ color: "var(--warm)" }}>
              Bed {reading.bed.toFixed(1)}°C
            </div>
          )}
          {reading.room != null && (
            <div
              className="tabular"
              style={{ color: "var(--text-muted)" }}
            >
              Room {reading.room.toFixed(1)}°C
            </div>
          )}
        </div>
      )}

      {/* Legend — identity is never carried by colour alone. */}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
        <LegendKey color="var(--warm)" label="Bed temp (°C)" />
        <LegendKey color="var(--text-faint)" label="Room temp" dashed />
        <LegendKey color="var(--stage-awake)" label="Toss & turn" tick />
        <LegendKey color="var(--accent)" label="Scheduled change" dot />
        <LegendKey color="var(--warm)" label="Live nudge" dot />
      </div>
    </div>
  );
};

const LegendKey: React.FC<{
  color: string;
  label: string;
  dashed?: boolean;
  dot?: boolean;
  tick?: boolean;
}> = ({ color, label, dashed, dot, tick }) => (
  <span className="flex items-center gap-1.5" style={{ color: "var(--text-muted)" }}>
    {dot ? (
      <span
        className="inline-block h-2 w-2 rounded-full"
        style={{ backgroundColor: color }}
      />
    ) : tick ? (
      <span
        className="inline-block h-2.5 w-[2px] rounded-full"
        style={{ backgroundColor: color }}
      />
    ) : (
      <span
        className="inline-block h-[2px] w-4 rounded-full"
        style={{
          backgroundColor: dashed ? "transparent" : color,
          backgroundImage: dashed
            ? `repeating-linear-gradient(90deg, ${color} 0 3px, transparent 3px 6px)`
            : undefined,
        }}
      />
    )}
    {label}
  </span>
);
