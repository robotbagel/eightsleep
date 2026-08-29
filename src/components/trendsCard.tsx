"use client";
import React, { useState } from "react";
import { type DisplayUnit } from "~/lib/temperature";
import { Card } from "./ui/card";
import LordIcon from "./ui/lordIcon";
import { NightDetail } from "./nightTimeline";
import { OutlookCard } from "./outlookCard";
import { CompareCard } from "./compareCard";

type TabKey = "night" | "recent" | "compare";

const TABS: { key: TabKey; label: string; icon: string; hint: string }[] = [
  { key: "night", label: "Night", icon: "clock", hint: "Hour by hour" },
  { key: "recent", label: "Recent", icon: "sleep", hint: "Last two nights and tonight" },
  { key: "compare", label: "Compare", icon: "chart", hint: "7, 14 or 30 days" },
];

/**
 * The three views of the same data that used to be three always-on cards. Tabs
 * add pages without adding scroll: only one panel is ever on screen, and the
 * labels say which (canon §10 — an icon names nothing on its own).
 */
export const TrendsCard: React.FC<{
  displayUnit: DisplayUnit;
  night: string | null;
  index?: number;
}> = ({ displayUnit, night, index = 0 }) => {
  const [tab, setTab] = useState<TabKey>("night");
  const active = TABS.find((t) => t.key === tab)!;

  return (
    <Card index={index} padded={false}>
      <div
        className="flex items-center gap-1 border-b p-2"
        role="tablist"
        aria-label="Sleep views"
        style={{ borderColor: "var(--border)" }}
      >
        {TABS.map((entry) => {
          const selected = entry.key === tab;
          return (
            <button
              key={entry.key}
              id={`tab-${entry.key}`}
              role="tab"
              aria-selected={selected}
              aria-controls={`panel-${entry.key}`}
              type="button"
              onClick={() => setTab(entry.key)}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-[13px] font-semibold transition-colors duration-fast ease-snap"
              style={{
                backgroundColor: selected ? "var(--surface-sunken)" : "transparent",
                color: selected ? "var(--text-headline)" : "var(--text-muted)",
                outline: selected ? "1px solid var(--border-strong)" : undefined,
              }}
            >
              <LordIcon
                name={entry.icon}
                size={16}
                trigger="hover"
                target={`#tab-${entry.key}`}
                color={selected ? "var(--accent)" : "var(--text-faint)"}
              />
              {entry.label}
            </button>
          );
        })}
      </div>

      <p
        className="px-5 pt-4 text-xs"
        style={{ color: "var(--text-faint)" }}
      >
        {active.hint}
      </p>

      {/* Keyed so switching tabs cross-fades rather than snapping. */}
      <div
        key={tab}
        id={`panel-${tab}`}
        role="tabpanel"
        aria-labelledby={`tab-${tab}`}
        className="px-5 pb-5 pt-3"
        style={{
          animation: "fadeIn var(--motion-fast) var(--ease-out-snap) both",
        }}
      >
        {tab === "night" && (
          <NightDetail displayUnit={displayUnit} night={night} />
        )}
        {tab === "recent" && <OutlookCard bare />}
        {tab === "compare" && <CompareCard bare />}
      </div>
    </Card>
  );
};
