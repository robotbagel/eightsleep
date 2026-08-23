"use client";
import React from "react";
import { apiR } from "~/trpc/react";
import { Card, CardHeader, Skeleton } from "./ui/card";
import { TrendChart } from "./charts/trendChart";

export const TrendsCard: React.FC<{ index?: number }> = ({ index = 0 }) => {
  const query = apiR.user.getSleepSummary.useQuery(undefined, {
    retry: 1,
    refetchOnWindowFocus: false,
  });

  if (query.isLoading) {
    return (
      <Card index={index}>
        <CardHeader icon="chart" title="Recent nights" />
        <Skeleton className="h-32" />
      </Card>
    );
  }

  const nights = query.data?.nights ?? [];
  if (nights.length === 0) return null;

  const scored = nights.filter((n) => n.score != null);
  const best = scored.reduce(
    (top, n) => ((n.score ?? 0) > (top?.score ?? -1) ? n : top),
    scored[0],
  );

  return (
    <Card index={index}>
      <CardHeader
        icon="chart"
        title="Recent nights"
        subtitle={
          best
            ? `Best so far: ${best.score} on ${new Date(`${best.date}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`
            : undefined
        }
      />
      <TrendChart nights={nights} />
    </Card>
  );
};
