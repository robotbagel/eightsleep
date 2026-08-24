"use client";
import React from "react";
import { formatRawByUnit, rawToCelsius, type DisplayUnit } from "~/lib/temperature";
import { type SettingsNight } from "./settingsHistory";

const STAGES = [
  { key: "initial", label: "Falling asleep", when: "first hour" },
  { key: "deep", label: "Deep sleep", when: "1–3h in" },
  { key: "mid", label: "Middle of the night", when: "until 2h before waking" },
  { key: "final", label: "REM & wake-up", when: "last 2 hours" },
] as const;

type StageKey = (typeof STAGES)[number]["key"];

/**
 * The three columns the question actually asks for: what the bed was set to
 * two nights ago, what it was set to last night, and what it is set to for
 * the night ahead — with the change spelled out per stage.
 *
 * Everything is in the user's chosen unit and the change column names its
 * direction in words, because a coloured arrow alone is not an answer.
 */
export const StageComparison: React.FC<{
  twoNightsAgo: SettingsNight | null;
  lastNight: SettingsNight | null;
  tonight: SettingsNight | null;
  /** A recommendation that is waiting to be applied, if any. */
  proposed: Record<StageKey, number | null> | null;
  unit: DisplayUnit;
}> = ({ twoNightsAgo, lastNight, tonight, proposed, unit }) => {
  const dayLabel = (night: SettingsNight | null) =>
    night
      ? new Date(`${night.night}T12:00:00Z`).toLocaleDateString("en-GB", {
          weekday: "short",
          day: "numeric",
          month: "short",
        })
      : "no record";

  const show = (value: number | null | undefined) =>
    value == null ? "—" : formatRawByUnit(value, unit);

  return (
    <div>
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <span className="card-title">What the bed is set to</span>
        <span className="text-[11px]" style={{ color: "var(--text-faint)" }}>
          {unit === "level" ? "slider level" : "bed water °C"}
        </span>
      </div>

      <div className="-mx-1 overflow-x-auto px-1">
        <table className="w-full min-w-[480px] border-collapse">
          <thead>
            <tr>
              <th className="w-[30%]" />
              <Head title="2 nights ago" sub={dayLabel(twoNightsAgo)} />
              <Head title="Last night" sub={dayLabel(lastNight)} />
              <Head title="Tonight" sub={dayLabel(tonight)} accent />
              <th className="w-[20%] pb-2 pl-2 text-left align-bottom">
                <span
                  className="block text-[10px] font-semibold uppercase tracking-wide"
                  style={{ color: "var(--text-faint)" }}
                >
                  Change
                </span>
              </th>
            </tr>
          </thead>
          <tbody>
            {STAGES.map((stage) => {
              const before = lastNight?.[stage.key] ?? null;
              const now = tonight?.[stage.key] ?? null;
              const wanted = proposed?.[stage.key] ?? null;
              const target = wanted ?? now;
              const delta =
                before != null && target != null
                  ? rawToCelsius(target) - rawToCelsius(before)
                  : null;
              const moved = delta != null && Math.abs(delta) >= 0.05;
              const cooler = moved && delta < 0;
              const color = !moved
                ? "var(--text-faint)"
                : cooler
                  ? "var(--cool)"
                  : "var(--warm)";

              return (
                <tr key={stage.key}>
                  <th scope="row" className="py-1.5 pr-2 text-left align-top">
                    <span
                      className="block text-[12px] font-medium"
                      style={{ color: "var(--text-headline)" }}
                    >
                      {stage.label}
                    </span>
                    <span
                      className="block text-[10px]"
                      style={{ color: "var(--text-faint)" }}
                    >
                      {stage.when}
                    </span>
                  </th>

                  <Cell value={show(twoNightsAgo?.[stage.key])} />
                  <Cell value={show(before)} />
                  <Cell
                    value={show(now)}
                    highlight
                    strike={wanted != null && wanted !== now}
                    extra={
                      wanted != null && wanted !== now
                        ? show(wanted)
                        : undefined
                    }
                  />

                  <td className="py-1.5 pl-2 align-middle">
                    <span
                      className="tabular text-[11px] font-semibold"
                      style={{ color }}
                    >
                      {!moved
                        ? "no change"
                        : `${cooler ? "cooler" : "warmer"} ${Math.abs(delta).toFixed(1)}°`}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {proposed && (
        <p className="mt-2 text-[11px]" style={{ color: "var(--warning)" }}>
          The struck-through values are what is loaded now; the ones beside them
          are what the AI proposes and will apply when you tap Apply tonight.
        </p>
      )}
    </div>
  );
};

const Head: React.FC<{
  title: string;
  sub: string;
  accent?: boolean;
}> = ({ title, sub, accent }) => (
  <th scope="col" className="w-[16%] pb-2 text-center align-bottom">
    <span
      className="block whitespace-nowrap text-[10px] font-semibold uppercase tracking-wide"
      style={{ color: accent ? "var(--accent)" : "var(--text-faint)" }}
    >
      {title}
    </span>
    <span
      className="tabular block text-[10px]"
      style={{ color: "var(--text-faint)" }}
    >
      {sub}
    </span>
  </th>
);

const Cell: React.FC<{
  value: string;
  highlight?: boolean;
  strike?: boolean;
  extra?: string;
}> = ({ value, highlight, strike, extra }) => (
  <td className="p-0.5 text-center align-middle">
    <span
      className="tabular block rounded-md py-1.5 text-[12px] font-semibold"
      style={{
        color: strike
          ? "var(--text-faint)"
          : highlight
            ? "var(--text-headline)"
            : "var(--text-muted)",
        backgroundColor: highlight ? "var(--surface-sunken)" : "transparent",
        outline: highlight ? "1px solid var(--border-strong)" : undefined,
        textDecoration: strike ? "line-through" : undefined,
      }}
    >
      {value}
      {extra && (
        <span className="ml-1.5" style={{ color: "var(--accent)" }}>
          {extra}
        </span>
      )}
    </span>
  </td>
);
