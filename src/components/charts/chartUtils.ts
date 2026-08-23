// Shared chart maths. Kept deliberately tiny and dependency-free: the whole
// app renders its charts as inline SVG so they inherit the theme tokens.

export type Point = [number, number]; // [epoch ms, value]

export const STAGE_ORDER = ["awake", "rem", "light", "deep"] as const;
export type StageKey = (typeof STAGE_ORDER)[number];

export const STAGE_LABEL: Record<StageKey, string> = {
  awake: "Awake",
  rem: "REM",
  light: "Light",
  deep: "Deep",
};

/** Token name per stage — never a raw hex at a call site. */
export const STAGE_VAR: Record<StageKey, string> = {
  awake: "var(--stage-awake)",
  rem: "var(--stage-rem)",
  light: "var(--stage-light)",
  deep: "var(--stage-deep)",
};

export function isStageKey(value: string): value is StageKey {
  return (STAGE_ORDER as readonly string[]).includes(value);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Nice-ish rounded domain with a little headroom on both ends. */
export function paddedDomain(
  values: number[],
  padding = 0.12,
): [number, number] {
  if (values.length === 0) return [0, 1];
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  if (hi === lo) return [lo - 1, hi + 1];
  const pad = (hi - lo) * padding;
  return [lo - pad, hi + pad];
}

/** Catmull-Rom-ish smoothing that never overshoots outside the data range. */
export function smoothPath(
  points: { x: number; y: number }[],
  tension = 0.35,
): string {
  if (points.length === 0) return "";
  if (points.length === 1) return `M ${points[0]!.x} ${points[0]!.y}`;
  let d = `M ${points[0]!.x} ${points[0]!.y}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i === 0 ? 0 : i - 1]!;
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    const p3 = points[i + 2 < points.length ? i + 2 : i + 1]!;
    const c1x = p1.x + ((p2.x - p0.x) / 6) * tension * 2;
    const c1y = p1.y + ((p2.y - p0.y) / 6) * tension * 2;
    const c2x = p2.x - ((p3.x - p1.x) / 6) * tension * 2;
    const c2y = p2.y - ((p3.y - p1.y) / 6) * tension * 2;
    d += ` C ${c1x.toFixed(2)} ${c1y.toFixed(2)}, ${c2x.toFixed(2)} ${c2y.toFixed(2)}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
  }
  return d;
}

export function clockIn(ms: number, timezone: string): string {
  return new Date(ms).toLocaleTimeString("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function shortDate(iso: string, timezone?: string): string {
  const date = new Date(`${iso}T12:00:00Z`);
  return date.toLocaleDateString("en-GB", {
    timeZone: timezone,
    day: "numeric",
    month: "short",
  });
}

export function weekdayLetter(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", {
    weekday: "short",
  });
}

/** 7.4 → "7h 24m". Null-safe because half the pod fields are nullable. */
export function formatHours(hours: number | null | undefined): string {
  if (hours == null || !isFinite(hours)) return "—";
  const total = Math.round(hours * 60);
  return `${Math.floor(total / 60)}h ${String(total % 60).padStart(2, "0")}m`;
}

/** Hour gridline positions across a time domain, at the given step in hours. */
export function hourTicks(t0: number, t1: number, stepHours = 2): number[] {
  const step = stepHours * 3_600_000;
  const first = Math.ceil(t0 / step) * step;
  const ticks: number[] = [];
  for (let t = first; t <= t1; t += step) ticks.push(t);
  return ticks;
}

/** The score bands the whole app reads by: ≥80 good, ≥60 fair, below poor. */
export function scoreTone(score: number | null | undefined):
  | "good"
  | "warn"
  | "bad"
  | "none" {
  if (score == null) return "none";
  if (score >= 80) return "good";
  if (score >= 60) return "warn";
  return "bad";
}

export const TONE_VAR: Record<"good" | "warn" | "bad" | "none", string> = {
  good: "var(--success)",
  warn: "var(--warning)",
  bad: "var(--danger)",
  none: "var(--text-faint)",
};
