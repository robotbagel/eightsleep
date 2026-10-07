"use client";
import React, { useEffect, useMemo, useRef, useState } from "react";
import LordIcon from "./ui/lordIcon";
import { clockIn } from "./charts/chartUtils";
import { soundIcon } from "./charts/nightChart";
import { soundLabel } from "~/lib/soundLabels";

export interface HeardSound {
  id: number | null;
  at: number;
  kind: string;
  aboveQuietDb: number | null;
  hasClip: boolean;
}

type Filter = "all" | "cats" | "woke";

/** A wake-up or toss this soon after a sound is shown as following it. */
const FOLLOW_MS = 2 * 60_000;
const COLLAPSED = 8;

/**
 * Every sound of the night as a list you can read and play, instead of
 * hunting for icons along a timeline with a finger. Each row says what the
 * bed saw right after it, so you can judge cause and coincidence yourself.
 */
export const NightSounds: React.FC<{
  sounds: HeardSound[];
  timezone: string;
  wakeUps: number[];
  tosses: number[];
  onFocus: (at: number | null) => void;
}> = ({ sounds, timezone, wakeUps, tosses, onFocus }) => {
  const [filter, setFilter] = useState<Filter>("all");
  const [expanded, setExpanded] = useState(false);
  const [playing, setPlaying] = useState<number | null>(null);
  const [loading, setLoading] = useState<number | null>(null);
  const [failed, setFailed] = useState<number | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);

  useEffect(() => () => audio.current?.pause(), []);

  const rows = useMemo(
    () =>
      [...sounds]
        .sort((a, b) => a.at - b.at)
        .map((s) => {
          const woke = wakeUps.some((t) => t >= s.at - 15_000 && t - s.at <= FOLLOW_MS);
          const turned = !woke && tosses.some((t) => t >= s.at - 15_000 && t - s.at <= FOLLOW_MS);
          return { ...s, woke, turned };
        }),
    [sounds, wakeUps, tosses],
  );
  const visible = rows.filter((r) =>
    filter === "cats" ? r.kind.startsWith("cat") : filter === "woke" ? r.woke : true,
  );
  const shown = expanded ? visible : visible.slice(0, COLLAPSED);

  if (rows.length === 0) return null;

  const play = (row: (typeof rows)[number]) => {
    if (row.id == null) return;
    if (playing === row.id) {
      audio.current?.pause();
      setPlaying(null);
      return;
    }
    audio.current?.pause();
    const el = new Audio(`/api/soundClip/${row.id}`);
    audio.current = el;
    setFailed(null);
    setLoading(row.id);
    el.onplaying = () => {
      setLoading(null);
      setPlaying(row.id);
    };
    el.onended = () => setPlaying(null);
    el.onerror = () => {
      setLoading(null);
      setPlaying(null);
      setFailed(row.id);
    };
    void el.play().catch(() => {
      setLoading(null);
      setFailed(row.id);
    });
  };

  const FILTERS: [Filter, string, number][] = [
    ["all", "All", rows.length],
    ["cats", "Cats", rows.filter((r) => r.kind.startsWith("cat")).length],
    ["woke", "Before a wake-up", rows.filter((r) => r.woke).length],
  ];

  return (
    <section className="mt-5" aria-label="Sounds heard in the night">
      <div className="flex items-baseline justify-between gap-3">
        <h4 className="text-sm font-semibold" style={{ color: "var(--text-headline)" }}>
          Heard in the night
        </h4>
        <span className="text-xs" style={{ color: "var(--text-faint)" }}>
          tap a row to mark it on the chart
        </span>
      </div>

      <div role="tablist" className="mt-2 flex gap-1.5 overflow-x-auto pb-1 [scrollbar-width:none]">
        {FILTERS.map(([key, label, count]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={filter === key}
            onClick={() => {
              setFilter(key);
              setExpanded(false);
            }}
            className="shrink-0 rounded-full border px-3 py-1.5 text-xs font-semibold transition-[background-color,border-color,transform] duration-fast ease-snap active:scale-[0.97] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
            style={{
              borderColor: filter === key ? "var(--accent)" : "var(--border)",
              background: filter === key ? "var(--accent-soft)" : "transparent",
              color: filter === key ? "var(--text-headline)" : "var(--text-muted)",
              outlineColor: "var(--accent)",
            }}
          >
            {label} <span className="tabular" style={{ color: "var(--text-faint)" }}>{count}</span>
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <p className="mt-3 text-sm" style={{ color: "var(--text-muted)" }}>
          {filter === "woke"
            ? "No wake-up came within two minutes of a sound."
            : "No cat was heard or seen this night."}
        </p>
      ) : (
        <ul className="mt-2 divide-y" style={{ borderColor: "var(--border)" }}>
          {shown.map((row) => {
            const rowId = `heard-${row.id ?? row.at}`;
            const isSelected = selected === row.at;
            return (
              <li
                key={rowId}
                id={rowId}
                className="flex min-h-[56px] items-center gap-3 py-2"
                style={{ borderColor: "var(--border)" }}
              >
                <button
                  type="button"
                  onClick={() => {
                    const next = isSelected ? null : row.at;
                    setSelected(next);
                    onFocus(next);
                  }}
                  aria-pressed={isSelected}
                  className="flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left transition-[background-color] duration-fast ease-snap focus-visible:outline focus-visible:outline-2"
                  style={{
                    background: isSelected ? "var(--accent-soft)" : "transparent",
                    outlineColor: "var(--accent)",
                  }}
                >
                  <span className="tabular w-11 shrink-0 text-sm font-semibold" style={{ color: "var(--text-headline)" }}>
                    {clockIn(row.at, timezone)}
                  </span>
                  <LordIcon
                    name={soundIcon(row.kind)}
                    size={22}
                    trigger="hover"
                    target={`#${rowId}`}
                    color="var(--warning)"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm" style={{ color: "var(--text)" }}>
                      {soundLabel(row.kind)}
                      {row.aboveQuietDb != null && row.aboveQuietDb > 0 && (
                        <span className="tabular" style={{ color: "var(--text-faint)" }}>
                          {" "}+{Math.round(row.aboveQuietDb)} dB
                        </span>
                      )}
                    </span>
                    <span
                      className="block text-xs"
                      style={{ color: row.woke ? "var(--warning)" : "var(--text-faint)" }}
                    >
                      {row.woke
                        ? "you woke up right after"
                        : row.turned
                          ? "you turned over right after"
                          : "no reaction in bed"}
                      {failed === row.id ? " · could not play" : ""}
                    </span>
                  </span>
                </button>
                {row.hasClip && row.id != null && (
                  <button
                    type="button"
                    onClick={() => play(row)}
                    aria-label={playing === row.id ? `Stop ${soundLabel(row.kind)}` : `Play ${soundLabel(row.kind)}`}
                    disabled={loading === row.id}
                    id={`${rowId}-play`}
                    className="grid h-11 w-11 shrink-0 place-items-center rounded-full border transition-[transform,border-color] duration-fast ease-snap active:scale-[0.94] disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                    style={{ borderColor: "var(--border-strong)", outlineColor: "var(--accent)" }}
                  >
                    <LordIcon
                      name={playing === row.id ? "pause" : "play"}
                      size={24}
                      trigger="hover"
                      target={`#${rowId}-play`}
                      color="var(--accent)"
                    />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {visible.length > COLLAPSED && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="btn btn-ghost mt-1 w-full text-sm"
        >
          {expanded ? "Show fewer" : `Show all ${visible.length}`}
        </button>
      )}
    </section>
  );
};
