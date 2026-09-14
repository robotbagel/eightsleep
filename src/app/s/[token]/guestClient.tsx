"use client";

// The whole interface a guest gets: how warm the bed is, warmer, cooler, and
// a way to say it is wrong. No history, no settings, no schedule — a visitor
// wants tonight to be comfortable, not a dashboard, and the narrower this is
// the less a leaked link can do.

import React, { useState } from "react";
import { apiR } from "~/trpc/react";

/** One press moves the bed by this much. Matches the loop's own step. */
const STEP_C = 0.5;

export const GuestClient: React.FC<{ token: string }> = ({ token }) => {
  const utils = apiR.useUtils();
  const view = apiR.share.view.useQuery({ token }, { retry: false });
  const [pending, setPending] = useState<number | null>(null);
  const [said, setSaid] = useState<string | null>(null);

  const setTemp = apiR.share.setTemperature.useMutation({
    onSettled: async () => {
      setPending(null);
      await utils.share.view.invalidate();
    },
  });
  const comfort = apiR.share.comfort.useMutation({
    onSuccess: (result) => setSaid(result.message),
  });

  if (view.isLoading) {
    return (
      <Shell>
        <p style={{ color: "var(--text-muted)" }}>Opening…</p>
      </Shell>
    );
  }

  if (view.isError) {
    return (
      <Shell>
        <h1 className="text-xl font-semibold" style={{ color: "var(--text-headline)" }}>
          This link is not working
        </h1>
        <p className="mt-2 text-sm" style={{ color: "var(--text-muted)" }}>
          {view.error.message}
        </p>
      </Shell>
    );
  }

  const data = view.data;
  if (!data) {
    return (
      <Shell>
        <p style={{ color: "var(--text-muted)" }}>Opening…</p>
      </Shell>
    );
  }

  const shown = pending ?? data.currentC;
  const canStep = data.currentC != null && data.capabilities.setTemperature;

  const step = (delta: number) => {
    if (data.currentC == null) return;
    const next = Math.min(
      data.maxC,
      Math.max(data.minC, Math.round((shown ?? data.currentC) * 2) / 2 + delta),
    );
    setPending(next);
    setTemp.mutate({ token, celsius: next });
  };

  return (
    <Shell>
      <header>
        <h1 className="text-2xl font-semibold tracking-[-0.02em]" style={{ color: "var(--text-headline)" }}>
          {data.label ? `Hello, ${data.label}` : "Your side of the bed"}
        </h1>
        <p className="mt-1 text-sm" style={{ color: "var(--text-muted)" }}>
          Bedtime {data.bedTime}, alarm {data.wakeupTime}. Change it whenever
          you like — it will not affect anybody else&apos;s settings.
        </p>
      </header>

      <section
        className="mt-6 rounded-2xl p-6 text-center"
        style={{ background: "var(--surface-raised)", border: "1px solid var(--border)" }}
      >
        <p className="text-xs uppercase tracking-wide" style={{ color: "var(--text-faint)" }}>
          Bed temperature
        </p>
        <p
          className="tabular mt-2 text-5xl font-semibold"
          style={{ color: "var(--text-headline)" }}
        >
          {shown != null ? `${shown.toFixed(1)}°` : "—"}
        </p>
        <p className="mt-1 text-xs" style={{ color: "var(--text-faint)" }}>
          {data.isHeating ? "The bed is on" : "The bed is off right now"}
        </p>

        <div className="mt-5 flex items-center justify-center gap-3">
          <button
            type="button"
            disabled={!canStep || setTemp.isPending}
            onClick={() => step(-STEP_C)}
            className="btn btn-secondary"
          >
            Cooler
          </button>
          <button
            type="button"
            disabled={!canStep || setTemp.isPending}
            onClick={() => step(STEP_C)}
            className="btn btn-primary"
          >
            Warmer
          </button>
        </div>
        {setTemp.isError && (
          <p className="mt-3 text-xs" style={{ color: "var(--danger)" }}>
            {setTemp.error.message}
          </p>
        )}
      </section>

      {data.capabilities.giveComfortFeedback && (
        <section className="mt-6">
          <p className="text-sm font-medium" style={{ color: "var(--text)" }}>
            How does it feel?
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {(
              [
                ["too_hot", "Too hot"],
                ["just_right", "Just right"],
                ["too_cold", "Too cold"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                disabled={comfort.isPending}
                onClick={() =>
                  comfort.mutate({ token, felt: value, whenFelt: "not_sure" })
                }
                className="btn btn-secondary"
              >
                {label}
              </button>
            ))}
          </div>
          {said && (
            <p className="mt-2 text-xs" style={{ color: "var(--success)" }}>
              {said}
            </p>
          )}
        </section>
      )}

      <footer className="mt-8 text-xs" style={{ color: "var(--text-faint)" }}>
        {data.expiresAt
          ? `This link stops working on ${new Date(data.expiresAt).toLocaleDateString()}.`
          : "This link does not expire."}
      </footer>
    </Shell>
  );
};

const Shell: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <main className="mx-auto min-h-screen w-full max-w-md px-5 py-10">{children}</main>
);
