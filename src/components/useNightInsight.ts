"use client";
import { useMemo } from "react";
import { apiR } from "~/trpc/react";
import { buildInsight, type Insight } from "~/lib/insights";

/**
 * The selected night and its reading against the sleeper's own last 30
 * nights. Shared by the summary chips, the night card and the vitals card;
 * the queries are keyed identically, so all three cost one request each.
 */
export function useNightInsight(night: string | null) {
  const timeline = apiR.user.getNightTimeline.useQuery(
    night ? { night } : undefined,
    { retry: 1, refetchOnWindowFocus: false },
  );
  const history = apiR.user.getSleepHistory.useQuery(
    { days: 30 },
    { retry: 1, refetchOnWindowFocus: false },
  );
  const metrics = timeline.data?.metrics ?? null;
  const nights = history.data?.nights;

  const insight: Insight | null = useMemo(() => {
    if (!metrics) return null;
    return buildInsight(
      {
        ...metrics,
        sleepLatencyHours: metrics.sleepLatencyHours ?? null,
        thermalScore: metrics.thermalScore ?? metrics.score ?? null,
      },
      (nights ?? []).map((n) => ({
        ...n,
        sleepLatencyHours: n.sleepLatencyHours ?? null,
      })),
    );
  }, [metrics, nights]);

  return { timeline, history, metrics, insight };
}
