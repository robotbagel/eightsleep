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

/**
 * Each family of sound gets its own row in the Sounds view, cats first: one
 * shared row let 60 "loud" marks bury the two meows that mattered.
 */
const SOUND_FAMILIES: { key: string; label: string }[] = [
  { key: "cat", label: "Cats" },
  { key: "speaker", label: "Noise" },
  { key: "door", label: "Thuds" },
  { key: "chat", label: "Voices" },
  { key: "snore", label: "Snoring" },
  { key: "dog", label: "Dog" },
];

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

/**
 * One story per view. Everything at once (stages, sounds, temperature,
 * tosses, AI changes) was accurate and unreadable on a phone, so the chart
 * shows one layer at a time over the same time axis and says in a sentence
 * what that layer found.
 */
type Lens = "sleep" | "sounds" | "temp";

const LENSES: { key: Lens; label: string; icon: string }[] = [
  { key: "sleep", label: "Sleep", icon: "sleep" },
  { key: "sounds", label: "Sounds", icon: "speaker" },
  { key: "temp", label: "Temperature", icon: "thermometer" },
];

/** A wake-up this soon after a sound is shown as following it (as in the list). */
const FOLLOW_MS = 2 * 60_000;
/** Tossing is summed per slice of the night and drawn as one shaded strip. */
const RESTLESS_SLICE_MS = 15 * 60_000;

// The viewBox width tracks the measured container width so the chart draws at
// 1:1 CSS pixels: stroke weights and block heights stay constant from a 375px
// phone to a 1280px desktop instead of being scaled up with the box.
// Wide enough for "AWAKE" at 10px uppercase without touching the first block.
const GUTTER = 42;
/** The Sounds view labels its rows with an icon, a name and a count. */
const SOUND_GUTTER = 78;

/** Vertical geometry per view; grows a little on wide cards. */
function layoutFor(width: number, lens: Lens, soundRows: number) {
  const k = Math.min(Math.max(width / 420, 1), 1.6);
  const none = { LANE_TOP: 0, LANE_H: 0, BLOCK_H: 0, STRIP_TOP: 0, STRIP_H: 0, TEMP_TOP: 0, TEMP_H: 0 };
  if (lens === "temp") {
    const TEMP_TOP = 10;
    const TEMP_H = Math.round(150 * k);
    return { ...none, TEMP_TOP, TEMP_H, H: TEMP_TOP + TEMP_H + 10 };
  }
  if (lens === "sounds") {
    // Row 0 is Awake, then one row per family of sound heard this night.
    const LANE_TOP = 6;
    const LANE_H = Math.round(30 * k);
    const BLOCK_H = Math.round(16 * k);
    return { ...none, LANE_TOP, LANE_H, BLOCK_H, H: LANE_TOP + LANE_H * soundRows + BLOCK_H + 4 };
  }
  const LANE_TOP = 10;
  const LANE_H = Math.round(30 * k);
  const BLOCK_H = Math.round(18 * k);
  const lanesEnd = LANE_TOP + LANE_H * 3 + BLOCK_H;
  const STRIP_TOP = lanesEnd + Math.round(14 * k);
  const STRIP_H = Math.round(8 * k);
  return { ...none, LANE_TOP, LANE_H, BLOCK_H, STRIP_TOP, STRIP_H, H: STRIP_TOP + STRIP_H + 6 };
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

const minutes = (ms: number) => Math.round(ms / 60_000);

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
  const boxRef = useRef<HTMLDivElement | null>(null);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const [W, setW] = useState(360);
  const [lens, setLens] = useState<Lens>("sleep");

  const lenses = LENSES.filter((l) => l.key !== "sounds" || sounds.length > 0);
  const activeLens: Lens = lenses.some((l) => l.key === lens) ? lens : "sleep";

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

  // Picking a sound in the list below shows it where sounds are drawn.
  useEffect(() => {
    if (focusAt != null && sounds.length > 0) {
      setLens("sounds");
      setCursor(focusAt);
    }
  }, [focusAt, sounds.length]);

  // Families heard this night, in a fixed order so rows never jump around.
  const families = SOUND_FAMILIES.filter((f) => sounds.some((s) => soundIcon(s.kind) === f.key));
  const X0 = activeLens === "sounds" ? SOUND_GUTTER : GUTTER;
  const X1 = W - 6;
  const { LANE_TOP, LANE_H, BLOCK_H, STRIP_TOP, STRIP_H, TEMP_TOP, TEMP_H, H } = layoutFor(
    W,
    activeLens,
    families.length,
  );

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

    // ---- restlessness: tosses per slice, as a share of the worst slice ----
    const slices: { from: number; count: number }[] = [];
    for (let from = t0; from < t1; from += RESTLESS_SLICE_MS) {
      slices.push({
        from,
        count: tosses.filter((t) => t >= from && t < from + RESTLESS_SLICE_MS).length,
      });
    }
    const maxSlice = Math.max(1, ...slices.map((s) => s.count));

    // ---- temperature series ---------------------------------------------
    const tempValues = [...bed, ...room].map(([, v]) => v);
    const [lo, hi] = tempValues.length > 0 ? paddedDomain(tempValues, 0.18) : [0, 1];
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
      slices,
      maxSlice,
      bedPoints,
      bedPath: smoothPath(bedPoints),
      roomPath: smoothPath(roomPoints),
      // Every hour when there is room for "00:00" labels, else every two.
      ticks: hourTicks(t0, t1, (X1 - X0) / ((t1 - t0) / 3_600_000) < 44 ? 2 : 1),
    };
  }, [sessionStart, sleepStart, sleepEnd, stages, wakeUps, bed, room, tosses, events, sounds, X0, X1, TEMP_TOP, TEMP_H]);

  if (!model) {
    return (
      <p className="py-6 text-center text-sm" style={{ color: "var(--text-muted)" }}>
        Not enough of the night recorded yet to draw it.
      </p>
    );
  }

  const { t0, t1, x, y, runs, briefWakes, slices, maxSlice, bedPoints, bedPath, roomPath, ticks } =
    model;

  const nearest = (series: Point[], time: number) => {
    if (series.length === 0) return null;
    let best = series[0]!;
    for (const point of series) {
      if (Math.abs(point[0] - time) < Math.abs(best[0] - time)) best = point;
    }
    return Math.abs(best[0] - time) < 90 * 60_000 ? best[1] : null;
  };

  // ---- one sentence per view ----------------------------------------------
  const asleepFrom = sleepStart ?? t0;
  const awakeSpells = runs.filter((r) => r.stage === "awake" && r.from > asleepFrom);
  const longest = awakeSpells.sort((a, b) => b.to - b.from - (a.to - a.from))[0];
  const wakeCount = wakeUps.length;
  const soundsBeforeWake = sounds.filter((s) =>
    wakeUps.some((t) => t >= s.at - 15_000 && t - s.at <= FOLLOW_MS),
  ).length;
  // The bedtime setting itself is not news; what changed after falling asleep is.
  const nightEvents = events.filter((e) => sleepStart == null || e.at > sleepStart);
  const bedValues = bed.map(([, v]) => v);
  const roomValues = room.map(([, v]) => v);
  const range = (values: number[]) =>
    values.length === 0
      ? null
      : Math.min(...values).toFixed(0) === Math.max(...values).toFixed(0)
        ? `${Math.min(...values).toFixed(0)}°C`
        : `${Math.min(...values).toFixed(0)}–${Math.max(...values).toFixed(0)}°C`;

  const summary =
    activeLens === "sleep"
      ? [
          wakeCount === 0
            ? "No wake-ups."
            : `Woke ${wakeCount === 1 ? "once" : `${wakeCount} times`}${briefWakes.length > 0 ? ", mostly for under a minute" : ""}.`,
          longest && longest.to - longest.from >= 3 * 60_000
            ? `Longest awake: ${minutes(longest.to - longest.from)} min at ${clockIn(longest.from, timezone)}.`
            : null,
        ]
          .filter(Boolean)
          .join(" ")
      : activeLens === "sounds"
        ? `${sounds.length} ${sounds.length === 1 ? "sound" : "sounds"} while in bed. ${
            soundsBeforeWake === 0
              ? "None came right before a wake-up."
              : `${soundsBeforeWake} came right before a wake-up.`
          }`
        : [
            range(bedValues) ? `Bed ${range(bedValues)}` : null,
            range(roomValues) ? `room ${range(roomValues)}` : null,
          ]
            .filter(Boolean)
            .join(", ") +
          `. ${
            nightEvents.length === 0
              ? "No changes during the night."
              : `${nightEvents.length} ${nightEvents.length === 1 ? "change" : "changes"} during the night.`
          }`;

  // ---- reading one moment ----------------------------------------------------
  const readAt = (time: number) => {
    const run = runs.find((r) => time >= r.from && time < r.to);
    // A brief wake-up is a minute wide on a ten-hour axis: catch it within
    // two minutes so a finger can actually land on it.
    const wokeBriefly = briefWakes.find((t) => Math.abs(t - time) <= 2 * 60_000) ?? null;
    return {
      stage: run?.stage ?? null,
      wokeBriefly,
      bed: nearest(bed, time),
      room: nearest(room, time),
      // Sounds within three minutes either side, so a touch on an awake
      // block names whatever was heard just before it.
      sounds: sounds.filter((s) => Math.abs(s.at - time) <= 3 * 60_000),
      event: events.find((e) => Math.abs(e.at - time) <= 5 * 60_000) ?? null,
    };
  };

  const moveTo = (clientX: number) => {
    const box = boxRef.current;
    if (!box) return;
    const rect = box.getBoundingClientRect();
    const px = clamp(((clientX - rect.left) / rect.width) * W, X0, X1);
    setCursor(t0 + ((px - X0) / (X1 - X0)) * (t1 - t0));
  };

  const reading = cursor == null ? null : readAt(cursor);
  const cursorX = cursor == null ? 0 : x(cursor);
  const showLanes = activeLens === "sleep";
  // A sound counts as "before a wake-up" by the same rule as the list below.
  const wokeAfter = (at: number) => wakeUps.some((t) => t >= at - 15_000 && t - at <= FOLLOW_MS);
  const rowMid = (row: number) => LANE_TOP + row * LANE_H + BLOCK_H / 2;

  // Connector between consecutive stage blocks, so the hypnogram reads as one
  // line through the night rather than loose bricks.
  const laneMid = (stage: StageKey) => LANE_TOP + STAGE_ORDER.indexOf(stage) * LANE_H + BLOCK_H / 2;
  const connector = runs
    .slice(1)
    .map((run, i) => {
      const prev = runs[i]!;
      if (prev.to !== run.from || prev.stage === run.stage) return "";
      return `M ${x(run.from)} ${laneMid(prev.stage)} V ${laneMid(run.stage)}`;
    })
    .join(" ");

  return (
    <div>
      {/* ---- View switch ---------------------------------------------------- */}
      <div role="tablist" aria-label="Chart view" className="mb-3 flex gap-1.5 overflow-x-auto [scrollbar-width:none]">
        {lenses.map((entry) => {
          const selected = entry.key === activeLens;
          return (
            <button
              key={entry.key}
              id={`lens-${entry.key}`}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => {
                setLens(entry.key);
                setCursor(null);
              }}
              className="flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold transition-[background-color,border-color,color,transform] duration-fast ease-snap hover:border-[var(--border-strong)] active:scale-[0.97] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
              style={{
                borderColor: selected ? "var(--accent)" : "var(--border)",
                background: selected ? "var(--accent-soft)" : "transparent",
                color: selected ? "var(--text-headline)" : "var(--text-muted)",
                outlineColor: "var(--accent)",
              }}
            >
              <LordIcon
                name={entry.icon}
                size={16}
                trigger="hover"
                target={`#lens-${entry.key}`}
                color={selected ? "var(--accent)" : "var(--text-faint)"}
              />
              {entry.label}
            </button>
          );
        })}
      </div>

      {/* ---- What this view found, or the moment being read ----------------- */}
      <div className="mb-2 flex min-h-[40px] items-start gap-2" aria-live="polite">
        {reading && cursor != null ? (
          <>
            <div className="min-w-0 flex-1 text-[13px] leading-snug" style={{ color: "var(--text)" }}>
              <span className="tabular font-semibold" style={{ color: "var(--text-headline)" }}>
                {clockIn(cursor, timezone)}
              </span>
              {activeLens !== "temp" && reading.stage && (
                <Chip color={STAGE_VAR[reading.stage]}>{STAGE_LABEL[reading.stage]}</Chip>
              )}
              {activeLens !== "temp" && reading.wokeBriefly != null && (
                <Chip color="var(--stage-awake)">woke briefly</Chip>
              )}
              {activeLens === "sounds" &&
                reading.sounds.map((s) => (
                  <Chip key={`rs-${s.at}-${s.kind}`} color="var(--cool)">
                    {clockIn(s.at, timezone)} {soundLabel(s.kind)}
                  </Chip>
                ))}
              {activeLens === "temp" && reading.bed != null && (
                <Chip color="var(--warm)">bed {reading.bed.toFixed(1)}°C</Chip>
              )}
              {activeLens === "temp" && reading.room != null && (
                <Chip color="var(--text-faint)">room {reading.room.toFixed(1)}°C</Chip>
              )}
              {activeLens === "temp" && reading.event && (
                <Chip color={SOURCE_COLOR[reading.event.source]}>{reading.event.label}</Chip>
              )}
            </div>
            <button
              type="button"
              onClick={() => setCursor(null)}
              className="btn btn-ghost shrink-0 px-2 py-1 text-xs"
            >
              Clear
            </button>
          </>
        ) : (
          <p className="text-[13px] leading-snug" style={{ color: "var(--text-muted)" }}>
            {summary}{" "}
            <span style={{ color: "var(--text-faint)" }}>Tap or slide along the chart to read a moment.</span>
          </p>
        )}
      </div>

      {/* ---- Chart ---------------------------------------------------------------
          Vertical swipes scroll the page (touch-action: pan-y); a tap or a
          sideways slide reads the night. Long-press selection and the iOS
          callout are switched off, since they only ever grabbed the chart. */}
      <div
        ref={boxRef}
        className="relative w-full select-none [-webkit-touch-callout:none] [-webkit-user-select:none]"
        style={{ height: H, touchAction: "pan-y" }}
        onContextMenu={(e) => e.preventDefault()}
        onPointerDown={(e) => {
          if (e.pointerType === "mouse") moveTo(e.clientX);
          else touchStart.current = { x: e.clientX, y: e.clientY };
        }}
        onPointerMove={(e) => {
          if (e.pointerType === "mouse") moveTo(e.clientX);
          else if (touchStart.current) moveTo(e.clientX);
        }}
        onPointerUp={(e) => {
          const start = touchStart.current;
          touchStart.current = null;
          if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) < 10) moveTo(e.clientX);
        }}
        onPointerCancel={() => {
          touchStart.current = null;
        }}
        onPointerLeave={(e) => {
          if (e.pointerType === "mouse") setCursor(null);
        }}
      >
        {/* Lane labels live in HTML so they stay at a real type size however
            wide the card gets — SVG <text> scales with the viewBox. */}
        {showLanes &&
          STAGE_ORDER.map((stage, lane) => (
            <span
              key={`lbl-${stage}`}
              className="absolute -translate-y-1/2 text-[10px] font-semibold uppercase tracking-wide"
              style={{
                left: 0,
                width: GUTTER,
                top: LANE_TOP + lane * LANE_H + BLOCK_H / 2,
                color: STAGE_VAR[stage],
              }}
            >
              {STAGE_LABEL[stage]}
            </span>
          ))}
        {activeLens === "sounds" && (
          <>
            <span
              className="absolute -translate-y-1/2 text-[10px] font-semibold uppercase tracking-wide"
              style={{ left: 0, width: SOUND_GUTTER, top: rowMid(0), color: "var(--stage-awake)" }}
            >
              Awake
            </span>
            {families.map((family, i) => {
              const count = sounds.filter((s) => soundIcon(s.kind) === family.key).length;
              return (
                <span
                  key={`fam-${family.key}`}
                  id={`fam-${family.key}`}
                  className="absolute flex -translate-y-1/2 items-center gap-1 text-[11px] font-semibold"
                  style={{ left: 0, width: SOUND_GUTTER, top: rowMid(i + 1), color: "var(--text-muted)" }}
                >
                  <LordIcon
                    name={family.key}
                    size={16}
                    trigger="hover"
                    target={`#fam-${family.key}`}
                    color="var(--cool)"
                  />
                  {family.label}
                  <span className="tabular font-normal" style={{ color: "var(--text-faint)" }}>
                    {count}
                  </span>
                </span>
              );
            })}
          </>
        )}
        {activeLens === "sleep" && (
          <span
            className="absolute -translate-y-1/2 text-[10px] font-semibold uppercase tracking-wide"
            style={{ left: 0, width: GUTTER, top: STRIP_TOP + STRIP_H / 2, color: "var(--text-faint)" }}
          >
            Toss
          </span>
        )}
        {activeLens === "temp" &&
          [model.hi, model.lo].map((value, i) => (
            <span
              key={`ty-${i}`}
              className="tabular absolute -translate-y-1/2 text-[10px]"
              style={{
                left: 0,
                width: GUTTER,
                top: i === 0 ? TEMP_TOP : TEMP_TOP + TEMP_H,
                color: "var(--text-faint)",
              }}
            >
              {value.toFixed(0)}°
            </span>
          ))}

        <svg
          key={activeLens}
          className="absolute inset-0 h-full w-full"
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={summary}
        >
          <defs>
            <linearGradient id="bedFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--warm)" stopOpacity="0.28" />
              <stop offset="100%" stopColor="var(--warm)" stopOpacity="0.02" />
            </linearGradient>
          </defs>

          {/* Hour gridlines, faint, so the eye can read down to the axis. */}
          {ticks.map((t) => (
            <line
              key={`grid-${t}`}
              x1={x(t)}
              x2={x(t)}
              y1={2}
              y2={H - 2}
              stroke="var(--border)"
              strokeWidth="1"
              opacity="0.6"
            />
          ))}

          {/* ---- Stages ------------------------------------------------------ */}
          {showLanes && (
            <g>
              <path d={connector} stroke="var(--border-strong)" strokeWidth="1" fill="none" />
              {runs.map((run, index) => {
                const left = x(run.from);
                return (
                  <rect
                    key={`run-${index}`}
                    className="grow-seg"
                    x={left}
                    y={LANE_TOP + STAGE_ORDER.indexOf(run.stage) * LANE_H}
                    width={Math.max(x(run.to) - left, 1.5)}
                    height={BLOCK_H}
                    rx={3}
                    fill={STAGE_VAR[run.stage]}
                    style={{ "--i": Math.min(index, 12) } as React.CSSProperties}
                  />
                );
              })}
            </g>
          )}

          {/* Brief wake-ups: a fixed-width pill in the Awake lane, so a
              40-second wake-up is as findable as a 15-minute one. Never
              dimmed: in the Sounds view they are what a sound is judged by. */}
          {showLanes &&
            briefWakes.map((t, index) => (
              <rect
                key={`wake-${index}`}
                x={x(t) - 3}
                y={LANE_TOP}
                width={6}
                height={BLOCK_H}
                rx={3}
                fill="var(--stage-awake)"
                stroke="var(--surface)"
                strokeWidth="1"
              />
            ))}

          {/* Tossing and turning as one strip: darker = more movement. */}
          {activeLens === "sleep" &&
            slices.map((slice) =>
              slice.count === 0 ? null : (
                <rect
                  key={`slice-${slice.from}`}
                  x={x(slice.from)}
                  y={STRIP_TOP}
                  width={Math.max(x(Math.min(slice.from + RESTLESS_SLICE_MS, t1)) - x(slice.from) - 1, 1)}
                  height={STRIP_H}
                  rx={2}
                  fill="var(--stage-awake)"
                  opacity={0.15 + 0.85 * (slice.count / maxSlice)}
                />
              ),
            )}

          {/* ---- Sounds: Awake on top, one row per family below ------------ */}
          {activeLens === "sounds" && (
            <g>
              {[0, ...families.map((_, i) => i + 1)].map((row) => (
                <line
                  key={`row-${row}`}
                  x1={X0}
                  x2={X1}
                  y1={rowMid(row)}
                  y2={rowMid(row)}
                  stroke="var(--border)"
                  strokeWidth="1"
                  strokeDasharray="1 4"
                  opacity="0.8"
                />
              ))}
              {runs
                .filter((run) => run.stage === "awake")
                .map((run, index) => (
                  <rect
                    key={`awake-${index}`}
                    x={x(run.from)}
                    y={LANE_TOP}
                    width={Math.max(x(run.to) - x(run.from), 2)}
                    height={BLOCK_H}
                    rx={3}
                    fill="var(--stage-awake)"
                  />
                ))}
              {briefWakes.map((t, index) => (
                <rect
                  key={`swake-${index}`}
                  x={x(t) - 3}
                  y={LANE_TOP}
                  width={6}
                  height={BLOCK_H}
                  rx={3}
                  fill="var(--stage-awake)"
                  stroke="var(--surface)"
                  strokeWidth="1"
                />
              ))}
              {/* A sound followed by a wake-up is drawn at full strength and
                  tied to the Awake row; the rest stay quiet. */}
              {sounds.map((sound, index) => {
                const row = families.findIndex((f) => f.key === soundIcon(sound.kind)) + 1;
                const woke = wokeAfter(sound.at);
                return (
                  <g key={`snd-${index}`} opacity={woke ? 1 : 0.5}>
                    {woke && (
                      <line
                        x1={x(sound.at)}
                        x2={x(sound.at)}
                        y1={LANE_TOP + BLOCK_H}
                        y2={LANE_TOP + row * LANE_H}
                        stroke="var(--cool)"
                        strokeWidth="1.5"
                        strokeDasharray="2 2"
                      />
                    )}
                    <rect
                      x={x(sound.at) - 2.5}
                      y={LANE_TOP + row * LANE_H}
                      width={5}
                      height={BLOCK_H}
                      rx={2.5}
                      fill="var(--cool)"
                    />
                  </g>
                );
              })}
            </g>
          )}

          {/* ---- Temperature (both series in °C, one axis) ------------------ */}
          {activeLens === "temp" && roomPath && (
            <path
              d={roomPath}
              fill="none"
              stroke="var(--text-faint)"
              strokeWidth="1.5"
              strokeDasharray="3 3"
              strokeLinecap="round"
            />
          )}
          {activeLens === "temp" && bedPath && bedPoints.length > 1 && (
            <>
              <path
                d={`${bedPath} L ${bedPoints[bedPoints.length - 1]!.x} ${TEMP_TOP + TEMP_H} L ${bedPoints[0]!.x} ${TEMP_TOP + TEMP_H} Z`}
                fill="url(#bedFill)"
              />
              <path
                d={bedPath}
                className="draw-line"
                style={{ "--len": 1400 } as React.CSSProperties}
                fill="none"
                stroke="var(--warm)"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </>
          )}
          {/* Each change sits on the bed line at the moment it was sent. */}
          {activeLens === "temp" &&
            events.map((event, index) => {
              const at = nearest(bed, event.at);
              return (
                <circle
                  key={`event-${index}`}
                  cx={x(event.at)}
                  cy={at != null ? y(at) : TEMP_TOP + TEMP_H - 6}
                  r="4"
                  fill={SOURCE_COLOR[event.source]}
                  stroke="var(--surface)"
                  strokeWidth="1.5"
                />
              );
            })}

          {/* ---- Cursor --------------------------------------------------- */}
          {cursor != null && (
            <>
              <line
                x1={cursorX}
                x2={cursorX}
                y1={2}
                y2={H - 2}
                stroke="var(--text)"
                strokeWidth="1.5"
                opacity="0.7"
              />
              {activeLens === "temp" && reading?.bed != null && (
                <circle
                  cx={cursorX}
                  cy={y(reading.bed)}
                  r="4"
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
            style={{ left: x(t), color: "var(--text-faint)" }}
          >
            {clockIn(t, timezone)}
          </span>
        ))}
      </div>

      {/* Legend for this view only — identity is never carried by colour alone. */}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
        {activeLens === "sleep" && (
          <>
            {briefWakes.length > 0 && <LegendKey color="var(--stage-awake)" label="Brief wake-up" pill />}
            <LegendKey color="var(--stage-awake)" label="Tossing (darker = more)" block />
          </>
        )}
        {activeLens === "sounds" && (
          <>
            <LegendKey color="var(--stage-awake)" label="Awake" pill />
            <LegendKey color="var(--cool)" label="Sound, bright if you woke right after" pill />
          </>
        )}
        {activeLens === "temp" && (
          <>
            <LegendKey color="var(--warm)" label="Bed" />
            <LegendKey color="var(--text-faint)" label="Room" dashed />
            {events.some((e) => e.source === "schedule") && (
              <LegendKey color="var(--accent)" label="Scheduled change" dot />
            )}
            {events.some((e) => e.source === "live") && <LegendKey color="var(--warm)" label="AI nudge" dot />}
            {events.some((e) => e.source === "manual") && (
              <LegendKey color="var(--cool)" label="You changed it" dot />
            )}
          </>
        )}
      </div>
    </div>
  );
};

const Chip: React.FC<{ color: string; children: React.ReactNode }> = ({ color, children }) => (
  <span className="ml-2 inline-flex items-center gap-1 whitespace-nowrap">
    <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
    {children}
  </span>
);

const LegendKey: React.FC<{
  color: string;
  label: string;
  dashed?: boolean;
  dot?: boolean;
  tick?: boolean;
  pill?: boolean;
  block?: boolean;
}> = ({ color, label, dashed, dot, tick, pill, block }) => (
  <span className="flex items-center gap-1.5" style={{ color: "var(--text-muted)" }}>
    {dot ? (
      <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
    ) : pill ? (
      <span className="inline-block h-2.5 w-[6px] rounded-full" style={{ backgroundColor: color }} />
    ) : block ? (
      <span
        className="inline-block h-2 w-4 rounded-sm"
        style={{ backgroundImage: `linear-gradient(90deg, color-mix(in srgb, ${color} 20%, transparent), ${color})` }}
      />
    ) : tick ? (
      <span className="inline-block h-2.5 w-[2px] rounded-full" style={{ backgroundColor: color }} />
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
