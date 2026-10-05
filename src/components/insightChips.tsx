"use client";
import React from "react";
import { apiR } from "~/trpc/react";
import { scoreTone, TONE_VAR } from "./charts/chartUtils";
import { useNightInsight } from "./useNightInsight";
import { STATUS_TONE } from "./vitalsCard";

const STAGE_SHORT: Record<string, string> = {
  initial: "first stage",
  deep: "deep stage",
  mid: "night",
  final: "morning",
};

/**
 * The whole morning in three words, before anything else: how you slept, how
 * your body coped, and what the bed will do tonight. Each chip is a jump to
 * the card that explains it (the iOS 27 Health app's summary row).
 */
export const InsightChips: React.FC<{ night: string | null }> = ({ night }) => {
  const { metrics, insight } = useNightInsight(night);
  const plan = apiR.user.getTemperaturePlan.useQuery(
    { days: 7 },
    { refetchOnWindowFocus: false },
  ).data;

  const score = metrics?.thermalScore ?? metrics?.score ?? null;

  let tonight: string | null = null;
  if (plan?.tonight) {
    const changed = (["initial", "deep", "mid", "final"] as const).filter(
      (stage) => plan.lastNight?.[stage] != null && plan.lastNight[stage] !== plan.tonight![stage],
    );
    if (!plan.assessedToday) tonight = "Not planned yet";
    else if (plan.proposed) tonight = "Needs your OK";
    else if (changed.length === 0) tonight = "No change";
    else {
      const first = changed[0]!;
      const cooler = plan.tonight[first] < plan.lastNight![first]!;
      tonight = `${cooler ? "Cooler" : "Warmer"} ${STAGE_SHORT[first]}`;
    }
  }

  const jump = (id: string) => () =>
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });

  if (!insight && !tonight) return null;

  return (
    <nav
      aria-label="Summary"
      className="-mx-4 flex snap-x gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none]"
    >
      {insight && (
        <Chip label="Sleep" onClick={jump("night-card")}>
          <MiniRing score={score} />
          <span style={{ color: "var(--text-headline)" }}>{insight.rating ?? "Not scored"}</span>
        </Chip>
      )}
      {insight?.vitalsStatus && (
        <Chip label="Body" onClick={jump("vitals")}>
          <span
            aria-hidden="true"
            className="h-2.5 w-2.5 shrink-0 rounded-full"
            style={{ background: STATUS_TONE[insight.vitalsStatus].color }}
          />
          <span style={{ color: "var(--text-headline)" }}>{insight.vitalsStatus}</span>
        </Chip>
      )}
      {tonight && (
        <Chip label="Tonight" onClick={jump("autopilot-strip")}>
          <span style={{ color: "var(--text-headline)" }}>{tonight}</span>
        </Chip>
      )}
    </nav>
  );
};

const Chip: React.FC<{
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}> = ({ label, onClick, children }) => (
  <button
    type="button"
    onClick={onClick}
    className="card flex shrink-0 snap-start flex-col items-start gap-0.5 rounded-2xl px-3.5 py-2 text-left transition-[transform,border-color] duration-fast ease-snap hover:-translate-y-px hover:border-[var(--border-strong)] active:scale-[0.97] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
    style={{ outlineColor: "var(--accent)" }}
  >
    <span className="text-xs" style={{ color: "var(--text-muted)" }}>
      {label}
    </span>
    <span className="flex items-center gap-1.5 text-sm font-semibold">{children}</span>
  </button>
);

const MiniRing: React.FC<{ score: number | null }> = ({ score }) => {
  const size = 18;
  const stroke = 3;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const fraction = score == null ? 0 : Math.max(0, Math.min(score / 100, 1));
  return (
    <svg width={size} height={size} className="-rotate-90 shrink-0" aria-hidden="true">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--surface-sunken)" strokeWidth={stroke} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={TONE_VAR[scoreTone(score)]}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - fraction)}
      />
    </svg>
  );
};
