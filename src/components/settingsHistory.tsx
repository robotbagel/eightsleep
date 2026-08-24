"use client";
import React from "react";
import { formatRawByUnit, type DisplayUnit } from "~/lib/temperature";

export interface SettingsNight {
  night: string;
  initial: number | null;
  deep: number | null;
  mid: number | null;
  final: number | null;
  aiChanged: boolean;
  aiStatus: string | null;
  liveNudges: number;
}

const STAGES = [
  { key: "initial", label: "Falling asleep" },
  { key: "deep", label: "Deep sleep" },
  { key: "mid", label: "Middle" },
  { key: "final", label: "REM & wake" },
] as const;

/**
 * What the bed was actually set to, night by night, with tonight as the last
 * column. This is the answer to "what was it yesterday, what is it now, and
 * what changes next" — a comparison of two numbers in prose never lands, but
 * a row you can read across does.
 */
export const SettingsHistory: React.FC<{
  history: SettingsNight[];
  todayKey: string | null;
  unit: DisplayUnit;
}> = ({ history, todayKey, unit }) => {
  if (history.length === 0) return null;

  const label = (night: string) => {
    const date = new Date(`${night}T12:00:00Z`);
    return {
      weekday: date.toLocaleDateString("en-GB", { weekday: "short" }),
      day: date.toLocaleDateString("en-GB", { day: "numeric" }),
    };
  };

  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <span className="card-title">What the bed was set to</span>
        <span className="text-[11px]" style={{ color: "var(--text-faint)" }}>
          each night, ending tonight
        </span>
      </div>

      <div className="-mx-1 overflow-x-auto px-1 pb-1">
        <table className="w-full min-w-[420px] border-collapse">
          <thead>
            <tr>
              <th className="w-[92px]" />
              {history.map((night) => {
                const isTonight = night.night === todayKey;
                const { weekday, day } = label(night.night);
                return (
                  <th
                    key={night.night}
                    scope="col"
                    className="px-1 pb-2 text-center align-bottom"
                  >
                    <span
                      className="block text-[10px] font-semibold uppercase tracking-wide"
                      style={{
                        color: isTonight ? "var(--accent)" : "var(--text-faint)",
                      }}
                    >
                      {isTonight ? "Tonight" : weekday}
                    </span>
                    {!isTonight && (
                      <span
                        className="tabular block text-[10px]"
                        style={{ color: "var(--text-faint)" }}
                      >
                        {day}
                      </span>
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {STAGES.map((stage) => (
              <tr key={stage.key}>
                <th
                  scope="row"
                  className="py-1 pr-2 text-left text-[11px] font-normal"
                  style={{ color: "var(--text-muted)" }}
                >
                  {stage.label}
                </th>
                {history.map((night, index) => {
                  const value = night[stage.key];
                  const previous =
                    index > 0 ? history[index - 1]![stage.key] : null;
                  const isTonight = night.night === todayKey;
                  const moved =
                    value != null && previous != null && value !== previous;
                  const cooler = moved && value < previous;
                  return (
                    <td key={night.night} className="p-0.5 text-center">
                      <span
                        className="tabular block rounded-md py-1 text-[11px] font-semibold"
                        style={{
                          color:
                            value == null
                              ? "var(--text-faint)"
                              : moved
                                ? cooler
                                  ? "var(--cool)"
                                  : "var(--warm)"
                                : isTonight
                                  ? "var(--text-headline)"
                                  : "var(--text-muted)",
                          backgroundColor: moved
                            ? cooler
                              ? "var(--cool-soft)"
                              : "var(--warm-soft)"
                            : isTonight
                              ? "var(--surface-sunken)"
                              : "transparent",
                          outline: isTonight
                            ? "1px solid var(--border-strong)"
                            : undefined,
                        }}
                        title={
                          moved
                            ? `${cooler ? "Cooler" : "Warmer"} than the night before`
                            : undefined
                        }
                      >
                        {value == null ? "—" : formatRawByUnit(value, unit)}
                      </span>
                    </td>
                  );
                })}
              </tr>
            ))}
            <tr>
              <th
                scope="row"
                className="pr-2 pt-1 text-left text-[10px] font-normal"
                style={{ color: "var(--text-faint)" }}
              >
                Changed by AI
              </th>
              {history.map((night) => (
                <td key={night.night} className="pt-1 text-center">
                  <span
                    className="text-[10px]"
                    style={{
                      color: night.aiChanged
                        ? "var(--accent)"
                        : "var(--text-faint)",
                    }}
                    title={
                      night.aiStatus
                        ? `Assessment status: ${night.aiStatus}`
                        : "No assessment recorded"
                    }
                  >
                    {night.aiChanged ? "yes" : night.aiStatus ? "no" : "·"}
                  </span>
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>

      <div
        className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px]"
        style={{ color: "var(--text-faint)" }}
      >
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block h-2.5 w-4 rounded"
            style={{ backgroundColor: "var(--cool-soft)" }}
          />
          cooler than the night before
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block h-2.5 w-4 rounded"
            style={{ backgroundColor: "var(--warm-soft)" }}
          />
          warmer
        </span>
        <span>· = no assessment that day</span>
      </div>
    </div>
  );
};
