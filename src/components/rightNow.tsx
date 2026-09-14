"use client";

// The control you want at three in the morning.
//
// Before this, being too warm in bed meant one of two things: open the folded
// schedule panel, work out which of four stages was running, edit that
// number and save — half asleep — or answer a prompt with words ("too hot",
// "middle of the night") that describes the problem to the system instead of
// fixing it.
//
// The press IS the report. Direction says which way it is wrong, and the
// schedule already knows which stage is running, so the morning gets its
// comfort report without anyone choosing a word. Same recorder as a hand
// adjustment made in the Eight app, so the pod holds it for the rest of the
// night and the live tuner stops trying to correct it.
//
// Motion per CANON: press feedback is the .btn scale(0.97) at
// --motion-instant, the reading cross-fades at --motion-fast on
// --ease-out-snap, and the control is locked while a write is in flight
// because "a dead button gets pressed twice".

import React, { useState } from "react";
import { apiR } from "~/trpc/react";
import { Card } from "./ui/card";
import LordIcon from "./ui/lordIcon";
import { formatRawByUnit, celsiusToRaw, type DisplayUnit } from "~/lib/temperature";

/** One press. Matches the loop's own grid, so a press is a settable value. */
const STEP_C = 0.5;

const STAGE_WORDS: Record<string, string> = {
  initial: "while you fall asleep",
  deep: "through your deep sleep",
  mid: "for the middle of the night",
  final: "up to your alarm",
};

export const RightNow: React.FC<{ displayUnit: DisplayUnit; index?: number }> = ({
  displayUnit,
  index = 0,
}) => {
  const utils = apiR.useUtils();
  const live = apiR.user.getLiveTemperature.useQuery(undefined, {
    retry: 1,
    refetchOnWindowFocus: true,
  });
  // Shown immediately on press so the number never lags the finger; the
  // server's answer replaces it on settle.
  const [optimisticC, setOptimisticC] = useState<number | null>(null);

  const nudge = apiR.user.nudgeTemperature.useMutation({
    onSuccess: (result) => setOptimisticC(result.currentC),
    onSettled: async () => {
      await utils.user.getLiveTemperature.invalidate();
      setOptimisticC(null);
      // The adjustment is now part of tonight's trail and tomorrow's
      // evidence, so anything showing either must be refetched.
      await Promise.all([
        utils.user.getNightTimeline.invalidate(),
        utils.user.getAiRecommendations.invalidate(),
      ]);
    },
  });

  const data = live.data;
  if (live.isLoading || !data) return null;

  const shown = optimisticC ?? data.currentC;
  const asleep = data.stage != null;

  // Off and outside the sleep window is the ordinary daytime state: say so in
  // one line rather than offering controls for a bed nobody is in.
  if (!data.isHeating && !asleep) {
    return (
      <Card index={index}>
        <div className="flex items-center gap-3">
          <LordIcon name="bed" size={24} color="var(--text-faint)" trigger="hover" target=".card" />
          <p className="text-sm" style={{ color: "var(--text-muted)" }}>
            The bed is off. It warms up before your {data.bedTime} bedtime.
          </p>
        </div>
      </Card>
    );
  }

  const label = (celsius: number) =>
    formatRawByUnit(celsiusToRaw(celsius), displayUnit);

  return (
    <Card index={index}>
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-semibold" style={{ color: "var(--text)" }}>
            Too warm? Too cold?
          </p>
          <p className="mt-0.5 text-xs" style={{ color: "var(--text-muted)" }}>
            {data.stage
              ? `Half a degree either way, ${STAGE_WORDS[data.stage] ?? "right now"}. It holds for the rest of the night.`
              : "Half a degree either way, right now."}
          </p>
        </div>
      </div>

      <div className="mt-4 flex items-center justify-center gap-4">
        <StepButton
          direction="cooler"
          disabled={nudge.isPending || shown == null}
          onPress={() => {
            if (shown == null) return;
            setOptimisticC(Math.round((shown - STEP_C) * 2) / 2);
            nudge.mutate({ deltaC: -STEP_C });
          }}
        />

        <div className="min-w-[7rem] text-center">
          <span
            key={shown ?? "none"}
            className="tabular block text-4xl font-semibold"
            style={{
              color: "var(--text-headline)",
              animation: "rise var(--motion-fast) var(--ease-out-snap) both",
            }}
          >
            {shown == null ? "—" : label(shown)}
          </span>
          <span className="text-xs" style={{ color: "var(--text-faint)" }}>
            {data.isHeating ? "running now" : "set for tonight"}
          </span>
        </div>

        <StepButton
          direction="warmer"
          disabled={nudge.isPending || shown == null}
          onPress={() => {
            if (shown == null) return;
            setOptimisticC(Math.round((shown + STEP_C) * 2) / 2);
            nudge.mutate({ deltaC: STEP_C });
          }}
        />
      </div>

      {nudge.isError && (
        <p className="mt-3 text-center text-xs" style={{ color: "var(--danger)" }}>
          {nudge.error.message}
        </p>
      )}
    </Card>
  );
};

/**
 * A deliberately large target: this gets pressed in the dark, one-handed,
 * by someone who is not really awake. 56px square clears the 44px minimum
 * with room to spare for a missed tap.
 */
const StepButton: React.FC<{
  direction: "cooler" | "warmer";
  disabled: boolean;
  onPress: () => void;
}> = ({ direction, disabled, onPress }) => (
  <button
    type="button"
    onClick={onPress}
    disabled={disabled}
    aria-label={direction === "cooler" ? "Half a degree cooler" : "Half a degree warmer"}
    className="btn btn-secondary h-14 w-14 shrink-0 text-2xl"
    style={{
      color: direction === "cooler" ? "var(--cool)" : "var(--warm)",
      borderColor: direction === "cooler" ? "var(--cool)" : "var(--warm)",
    }}
  >
    {direction === "cooler" ? "−" : "+"}
  </button>
);
