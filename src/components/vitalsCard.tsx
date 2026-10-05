"use client";
import React from "react";
import { Card, CardHeader, Skeleton } from "./ui/card";
import { useNightInsight } from "./useNightInsight";
import { type Vital, type VitalStatus } from "~/lib/insights";

export const STATUS_TONE: Record<VitalStatus, { color: string; soft: string }> = {
  Typical: { color: "var(--success)", soft: "var(--success-soft)" },
  Favorable: { color: "var(--success)", soft: "var(--success-soft)" },
  "Slightly off": { color: "var(--warning)", soft: "var(--warning-soft)" },
  "Notably off": { color: "var(--danger)", soft: "var(--danger-soft)" },
};

const ICON: Record<Vital["key"], string> = {
  restingHeartRate: "heart",
  hrv: "chart",
  respiratoryRate: "lungs",
};

/**
 * Overnight vitals the way the Health app shows them: not three numbers to
 * remember, but each one placed on YOUR typical range, with a word for where
 * it landed. The sparklines that used to sit here live in Trends.
 */
export const VitalsCard: React.FC<{ night: string | null; index?: number }> = ({
  night,
  index = 0,
}) => {
  const { timeline, insight } = useNightInsight(night);
  if (timeline.isLoading) {
    return (
      <Card index={index}>
        <Skeleton className="h-4 w-40" />
        <div className="mt-4 space-y-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-9" />
          ))}
        </div>
      </Card>
    );
  }
  if (!insight || insight.vitals.every((v) => v.value == null)) return null;
  const tone = insight.vitalsStatus ? STATUS_TONE[insight.vitalsStatus] : null;

  return (
    <section id="vitals" className="scroll-mt-20">
      <Card index={index}>
        <CardHeader
          icon="heart"
          iconColor="var(--danger)"
          title="Overnight vitals"
          right={
            insight.vitalsStatus && tone ? (
              <span
                className="chip"
                style={{ color: tone.color, background: tone.soft, borderColor: tone.color }}
              >
                {insight.vitalsStatus}
              </span>
            ) : undefined
          }
        />
        <p className="text-sm leading-snug" style={{ color: "var(--text)" }}>
          {insight.vitalsSummary}
        </p>
        <ul className="mt-4 space-y-3">
          {insight.vitals.map((vital) => (
            <VitalRow key={vital.key} vital={vital} />
          ))}
        </ul>
      </Card>
    </section>
  );
};

const VitalRow: React.FC<{ vital: Vital }> = ({ vital }) => {
  const id = `vital-${vital.key}`;
  const decimals = vital.key === "respiratoryRate" ? 1 : 0;
  const fmt = (x: number) => x.toFixed(decimals);
  const tone = vital.status ? STATUS_TONE[vital.status] : null;
  return (
    <li id={id} className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1">
      <span className="text-sm" style={{ color: "var(--text)" }}>
        {vital.label}
        {vital.status && vital.status !== "Typical" && (
          <span className="ml-2 text-xs font-semibold" style={{ color: tone?.color }}>
            {vital.status}
          </span>
        )}
      </span>
      <span className="tabular text-sm font-semibold" style={{ color: "var(--text-headline)" }}>
        {vital.value != null ? fmt(vital.value) : "—"}
        <span className="ml-1 text-xs font-normal" style={{ color: "var(--text-faint)" }}>
          {vital.unit}
        </span>
      </span>
      <RangeBand vital={vital} />
      <span className="tabular text-right text-xs" style={{ color: "var(--text-faint)" }}>
        {vital.low != null && vital.high != null
          ? `usual ${fmt(vital.low)}–${fmt(vital.high)}`
          : "learning your range"}
      </span>
    </li>
  );
};

/**
 * The usual range as a band across the middle of a track, and tonight as a
 * dot on it. The track runs a band-width either side, so "notably off" lands
 * visibly outside and anything further is pinned to the edge.
 */
const RangeBand: React.FC<{ vital: Vital }> = ({ vital }) => {
  const { value, low, high, status } = vital;
  if (value == null || low == null || high == null || high <= low) {
    return <span className="h-2 rounded-full" style={{ background: "var(--surface-sunken)" }} />;
  }
  const width = high - low;
  const min = low - width;
  const max = high + width;
  const at = Math.min(1, Math.max(0, (value - min) / (max - min)));
  const tone = status ? STATUS_TONE[status].color : "var(--accent)";
  return (
    <span
      className="relative block h-2 rounded-full"
      style={{ background: "var(--surface-sunken)" }}
      role="img"
      aria-label={`${vital.label} ${value.toFixed(1)}, usual range ${low.toFixed(1)} to ${high.toFixed(1)}`}
    >
      <span
        className="absolute inset-y-0 rounded-full"
        style={{
          left: "33.333%",
          width: "33.333%",
          background: "color-mix(in srgb, var(--success) 30%, transparent)",
        }}
      />
      <span
        className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2"
        style={{
          left: `${at * 100}%`,
          borderColor: "var(--surface)",
          background: tone,
          transition: "left var(--motion-base) var(--ease-out-snap)",
        }}
      />
    </span>
  );
};
