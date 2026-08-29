"use client";
import React from "react";
import { apiR } from "~/trpc/react";
import { formatRawByUnit, type DisplayUnit } from "~/lib/temperature";
import LordIcon from "./ui/lordIcon";

const STAGE_LABEL: Record<string, string> = {
  initial: "falling asleep",
  deep: "deep sleep",
  mid: "middle of the night",
  final: "REM and wake-up",
};

/**
 * One line answering "what is being done about it?" — the second question the
 * dashboard has to answer, and the one that was buried under a settings table,
 * two charts and a reasoning panel. Everything else about the autopilot lives
 * behind this, opened on demand (see ia-contract.json, level 1 and level 3).
 */
export const AutopilotStrip: React.FC<{
  displayUnit: DisplayUnit;
  onOpen: () => void;
  expanded: boolean;
}> = ({ displayUnit, onOpen, expanded }) => {
  const planQuery = apiR.user.getTemperaturePlan.useQuery(
    { days: 7 },
    { refetchOnWindowFocus: false },
  );
  const recommendationsQuery = apiR.user.getAiRecommendations.useQuery(
    undefined,
    { refetchOnWindowFocus: false },
  );

  const plan = planQuery.data;
  const latest = recommendationsQuery.data?.[0];
  if (!plan?.tonight) return null;
  const tonight = plan.tonight;

  const changed = (["initial", "deep", "mid", "final"] as const)
    .map((stage) => ({
      stage,
      from: plan.lastNight?.[stage] ?? null,
      to: tonight[stage],
    }))
    .filter((row) => row.from != null && row.from !== row.to);

  const pending = plan.proposed != null;

  let color = "var(--text)";
  let background = "var(--surface-sunken)";
  let text: React.ReactNode;

  if (!plan.assessedToday) {
    color = "var(--warning)";
    background = "var(--warning-soft)";
    text = "No assessment has run yet today — tonight is still last night's profile.";
  } else if (pending) {
    color = "var(--warning)";
    background = "var(--warning-soft)";
    text = "A change is waiting for you to approve before tonight.";
  } else if (changed.length > 0) {
    const first = changed[0]!;
    const cooler = first.to < first.from!;
    color = "var(--success)";
    background = "var(--success-soft)";
    text = (
      <>
        Tonight the {STAGE_LABEL[first.stage]} stage runs{" "}
        <span className="font-semibold">{cooler ? "cooler" : "warmer"}</span>,{" "}
        {formatRawByUnit(first.from!, displayUnit)} →{" "}
        {formatRawByUnit(first.to, displayUnit)}
        {changed.length > 1 ? ` (and ${changed.length - 1} more)` : ""}. Live on
        the pod.
      </>
    );
  } else {
    text =
      latest?.confidence === "high"
        ? "Nothing changed tonight — these settings are holding up, so they stay."
        : "Nothing changed tonight; the last change is still being measured.";
  }

  return (
    <button
      id="autopilot-strip"
      type="button"
      onClick={onOpen}
      aria-expanded={expanded}
      className="card enter flex w-full items-center gap-3 p-4 text-left transition-[transform,border-color] duration-fast ease-snap hover:-translate-y-px hover:border-[var(--border-strong)] active:scale-[0.995]"
      style={{ "--i": 1 } as React.CSSProperties}
    >
      <span
        className="grid h-9 w-9 shrink-0 place-items-center rounded-full"
        style={{ backgroundColor: background }}
      >
        <LordIcon
          name="ai"
          size={20}
          trigger="hover"
          target="#autopilot-strip"
          color={color}
        />
      </span>

      <span className="min-w-0 flex-1">
        <span className="card-title block">Autopilot</span>
        <span
          className="mt-0.5 block text-sm leading-snug"
          style={{ color: "var(--text)" }}
        >
          {text}
        </span>
      </span>

      <span
        className="shrink-0 text-xs font-semibold"
        style={{ color: "var(--text-muted)" }}
      >
        {expanded ? "Hide" : "Why"}
        <svg
          className="ml-1 inline transition-transform duration-fast ease-snap"
          width="10"
          height="10"
          viewBox="0 0 12 12"
          fill="none"
          aria-hidden="true"
          style={{ transform: expanded ? "rotate(180deg)" : undefined }}
        >
          <path
            d="M2.5 4.5 6 8l3.5-3.5"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
    </button>
  );
};
