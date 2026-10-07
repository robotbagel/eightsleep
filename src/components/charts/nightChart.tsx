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
import LordIcon from "../ui/lordIcon";
import { soundLabel } from "~/lib/soundLabels";

/**
 * Groups sounds whose icons would overlap: the cluster takes the most common
 * kind for its icon and lists every sound in its label.
 */
function soundClusters(
  sounds: NightSound[],
  x: (t: number) => number,
  minGapPx: number,
): { at: number; kind: string; count: number; label: string }[] {
  const sorted = [...sounds].sort((a, b) => a.at - b.at);
  const groups: NightSound[][] = [];
  for (const s of sorted) {
    const last = groups[groups.length - 1];
    if (last && x(s.at) - x(last[0]!.at) < minGapPx) last.push(s);
    else groups.push([s]);
  }
  return groups.map((group) => {
    const tally = new Map<string, number>();
    for (const s of group) tally.set(s.kind, (tally.get(s.kind) ?? 0) + 1);
    const kind = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]![0];
    return {
      at: group[0]!.at,
      kind,
      count: group.length,
      label: [...tally.entries()]
        .map(([k, n]) => `${n > 1 ? `${n}× ` : ""}${soundLabel(k)}`)
        .join(", "),
    };
  });
}

/** Something the bedroom phone heard (sound.ts). */
export interface NightSound {
  at: number;
  kind: string;
  aboveQuietDb: number | null;
}

/** One Grunkicon per family of sound, so a glance reads "cat" or "door". */
export function soundIcon(kind: string): string {
  if (kind.startsWith("cat")) return "cat";
  if (kind.startsWith("dog")) return "dog";
  if (kind.startsWith("door") || kind === "knock" || kind === "thump_thud") return "door";
  if (kind === "snoring") return "snore";
  if (["speech", "laughter", "cough", "baby_crying"].includes(kind)) return "chat";
  return "speaker";
}

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
  /**
   * Every wake-up the night's summary counts. Most last under a minute and
   * never appear as an awake stage, so they are drawn in the Awake lane on
   * their own; otherwise the chart shows one awake block for "4 wake-ups".
   */
  wakeUps?: number[];
  events: NightEvent[];
  /** Sounds heard in the room; drawn as icons above the hypnogram. */
  sounds?: NightSound[];
  /** A moment picked from the list below: drawn as a solid marker. */
  focusAt?: number | null;
}

// Geometry. One viewBox, three stacked panels sharing the same time axis —
// small multiples, never a second y-scale on one plot.
//
// The viewBox width tracks the measured container width so the chart draws at
// 1:1 CSS pixels: stroke weights and block heights stay constant from a 375px
// phone to a 1280px desktop instead of being scaled up with the box.
// Wide enough for "AWAKE" at 10px uppercase without touching the first block.
const GUTTER = 42;
const X0 = GUTTER;

/** Vertical geometry grows a little with the card so a wide desktop chart does
 *  not look like a letterbox, while a 375px phone stays compact. */
function layoutFor(width: number, withSounds: boolean) {
  const k = Math.min(Math.max(width / 420, 1), 1.7);
  // A row of sound icons sits above the hypnogram when there is anything to
  // show, so a meow lines up with the awake block under it.
  const SOUND_TOP = 4;
  const SOUND_H = withSounds ? Math.round(24 * k) : 0;
  const LANE_TOP = SOUND_TOP + SOUND_H + (withSounds ? 6 : 4);
  const LANE_H = Math.round(22 * k);
  const BLOCK_H = Math.round(14 * k);
  const TEMP_TOP = LANE_TOP + LANE_H * 4 + Math.round(18 * k);
  const TEMP_H = Math.round(76 * k);
  const RAIL_TOP = TEMP_TOP + TEMP_H + Math.round(14 * k);
  const RAIL_H = Math.round(16 * k);
  return {
    SOUND_TOP,
    SOUND_H,
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
  wakeUps = [],
  events,
  sounds = [],
  focusAt = null,
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
  const {
    SOUND_TOP,
    SOUND_H,
    LANE_TOP,
    LANE_H,
    BLOCK_H,
    TEMP_TOP,
    TEMP_H,
    RAIL_TOP,
    RAIL_H,
    H,
  } = layoutFor(W, sounds.length > 0);

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
    for (const s of sounds) candidates.push(s.at);
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
    // Wake-ups already inside a drawn awake block need no second mark.
    const briefWakes = wakeUps.filter(
      (t) => !runs.some((r) => r.stage === "awake" && t >= r.from - 60_000 && t <= r.to + 60_000),
    );

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
      briefWakes,
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
    wakeUps,
    bed,
    room,
    tosses,
    events,
    sounds,
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

  const { t0, t1, x, y, runs, briefWakes, bedPoints, bedPath, roomPath, ticks } = model;

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
    // A brief wake-up is a minute wide on a ten-hour axis: catch it within
    // two minutes so a finger can actually land on it.
    const wokeBriefly = briefWakes.find((t) => Math.abs(t - time) <= 2 * 60_000) ?? null;
    return {
      stage: run?.stage ?? null,
      wokeBriefly,
      bed: nearest(bed),
      room: nearest(room),
      // Sounds within three minutes either side, so a hover over an awake
      // block names whatever was heard just before it.
      sounds: sounds.filter((s) => Math.abs(s.at - time) <= 3 * 60_000),
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

        {/* Brief wake-ups: a fixed-width pill in the Awake lane, so a
            40-second wake-up is as findable as a 15-minute one. */}
        {briefWakes.map((t, index) => (
          <rect
            key={`wake-${index}`}
            className="grow-seg"
            x={x(t) - 2.5}
            y={LANE_TOP}
            width={5}
            height={BLOCK_H}
            rx={2.5}
            fill="var(--stage-awake)"
            stroke="var(--surface)"
            strokeWidth="1"
            style={{ "--i": Math.min(index, 12) } as React.CSSProperties}
          />
        ))}

        {/* Each sound drops a faint line through the hypnogram, so you can
            see for yourself whether an awake block follows it. */}
        {sounds.map((s, index) => (
          <line
            key={`sound-${index}`}
            x1={x(s.at)}
            x2={x(s.at)}
            y1={SOUND_TOP + SOUND_H}
            y2={LANE_TOP + LANE_H * 4}
            stroke="var(--warning)"
            strokeWidth="1"
            strokeDasharray="2 3"
            opacity="0.6"
          />
        ))}

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

        {focusAt != null && focusAt >= t0 && focusAt <= t1 && (
          <line
            x1={x(focusAt)}
            x2={x(focusAt)}
            y1={SOUND_TOP}
            y2={RAIL_TOP + RAIL_H}
            stroke="var(--accent)"
            strokeWidth="2"
          />
        )}

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

        {/* Sound icons: HTML over the chart so they are real animated
            Grunkicons at a fixed size. Sounds closer than an icon's width
            share one icon with a count. */}
        {soundClusters(sounds, x, 18).map((cluster) => (
          <span
            key={`sc-${cluster.at}`}
            id={`sc-${cluster.at}`}
            className="absolute flex -translate-x-1/2 items-center"
            style={{
              left: `${(x(cluster.at) / W) * 100}%`,
              top: SOUND_TOP,
              height: SOUND_H,
            }}
            title={cluster.label}
            aria-label={cluster.label}
            role="img"
          >
            <LordIcon
              name={soundIcon(cluster.kind)}
              size={Math.min(SOUND_H, 20)}
              trigger="hover"
              target={`#sc-${cluster.at}`}
              color="var(--warning)"
            />
            {cluster.count > 1 && (
              <span
                className="tabular -ml-0.5 text-[10px] font-semibold"
                style={{ color: "var(--warning)" }}
              >
                {cluster.count}
              </span>
            )}
          </span>
        ))}
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
          {reading.wokeBriefly != null && (
            <div className="mt-0.5 flex items-center gap-1.5">
              <span
                className="inline-block h-1.5 w-1.5 rounded-full"
                style={{ backgroundColor: "var(--stage-awake)" }}
              />
              Woke briefly at {clockIn(reading.wokeBriefly, timezone)}
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
          {reading.sounds.map((s) => (
            <div key={`ts-${s.at}-${s.kind}`} className="tabular" style={{ color: "var(--warning)" }}>
              {clockIn(s.at, timezone)} {soundLabel(s.kind)}
              {s.aboveQuietDb != null ? `, +${Math.round(s.aboveQuietDb)} dB` : ""}
            </div>
          ))}
        </div>
      )}

      {/* Legend — identity is never carried by colour alone. */}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
        <LegendKey color="var(--warm)" label="Bed temp (°C)" />
        <LegendKey color="var(--text-faint)" label="Room temp" dashed />
        {briefWakes.length > 0 && (
          <LegendKey color="var(--stage-awake)" label="Brief wake-up" pill />
        )}
        <LegendKey color="var(--stage-awake)" label="Toss & turn" tick />
        <LegendKey color="var(--accent)" label="Scheduled change" dot />
        <LegendKey color="var(--warm)" label="Live nudge" dot />
        {sounds.length > 0 && (
          <LegendKey color="var(--warning)" label="Sound heard" tick />
        )}
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
  pill?: boolean;
}> = ({ color, label, dashed, dot, tick, pill }) => (
  <span className="flex items-center gap-1.5" style={{ color: "var(--text-muted)" }}>
    {dot ? (
      <span
        className="inline-block h-2 w-2 rounded-full"
        style={{ backgroundColor: color }}
      />
    ) : pill ? (
      <span
        className="inline-block h-2.5 w-[5px] rounded-full"
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
