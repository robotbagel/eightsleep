"use client";
import React, { useState } from "react";
import { apiR } from "~/trpc/react";
import LordIcon from "./ui/lordIcon";

/**
 * Asked once each morning: how did the bed actually feel?
 *
 * Everything else the autopilot reads is a proxy — tossing stands in for
 * discomfort, a raised heart rate stands in for being too warm. This is the
 * only direct reading of the thing the bed exists to get right, so it is worth
 * one card at the top of the page on the mornings it has not been answered,
 * and nothing at all on the mornings it has.
 */

const FELT = [
  { key: "too_hot", label: "Too hot", icon: "thermometer", color: "var(--warm)" },
  { key: "just_right", label: "Just right", icon: "sleep", color: "var(--success)" },
  { key: "too_cold", label: "Too cold", icon: "thermometer", color: "var(--cool)" },
] as const;

const WHEN = [
  { key: "falling_asleep", label: "Falling asleep" },
  { key: "middle", label: "Middle of the night" },
  { key: "morning", label: "Towards morning" },
  { key: "all_night", label: "All night" },
] as const;

type Felt = (typeof FELT)[number]["key"];
type When = (typeof WHEN)[number]["key"];

export const ComfortPrompt: React.FC<{ index?: number }> = ({ index = 0 }) => {
  const utils = apiR.useUtils();
  const query = apiR.user.getSleepFeedback.useQuery(undefined, {
    refetchOnWindowFocus: false,
  });
  const [felt, setFelt] = useState<Felt | null>(null);
  const [when, setWhen] = useState<When | null>(null);
  const [justSaved, setJustSaved] = useState(false);

  const submit = apiR.user.submitSleepFeedback.useMutation({
    onSuccess: async () => {
      setJustSaved(true);
      await Promise.all([
        utils.user.getSleepFeedback.invalidate(),
        utils.user.getAiRecommendations.invalidate(),
      ]);
    },
  });

  const data = query.data;
  if (!data || !data.askable || (data.answered && !justSaved)) return null;

  if (justSaved) {
    return (
      <section
        className="card enter flex items-center gap-3 p-4"
        style={{ "--i": index } as React.CSSProperties}
      >
        <span
          className="grid h-9 w-9 shrink-0 place-items-center rounded-full"
          style={{ backgroundColor: "var(--success-soft)" }}
        >
          <LordIcon name="sleep" size={20} trigger="in" color="var(--success)" />
        </span>
        <p className="text-sm" style={{ color: "var(--text)" }}>
          Thanks — the autopilot weighs that above anything it infers from
          tossing, and will use it tomorrow morning.
        </p>
      </section>
    );
  }

  const needsWhen = felt !== null && felt !== "just_right";
  const canSubmit = felt !== null && (!needsWhen || when !== null);

  return (
    <section
      className="card enter p-5"
      style={{ "--i": index } as React.CSSProperties}
      aria-labelledby="comfort-question"
    >
      <h2
        id="comfort-question"
        className="text-base font-semibold"
        style={{ color: "var(--text-headline)" }}
      >
        How did the bed feel last night?
      </h2>
      <p className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>
        One tap. The autopilot can measure how much you moved, but not how it
        felt — and that is the part it most needs.
      </p>

      <div className="mt-4 grid grid-cols-3 gap-2" role="radiogroup" aria-label="How it felt">
        {FELT.map((option) => {
          const selected = felt === option.key;
          return (
            <button
              key={option.key}
              id={`felt-${option.key}`}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => {
                setFelt(option.key);
                if (option.key === "just_right") setWhen(null);
              }}
              className="flex flex-col items-center gap-1.5 rounded-xl px-2 py-3 text-[13px] font-semibold transition-[transform,background-color,border-color] duration-fast ease-snap hover:-translate-y-px active:scale-[0.97]"
              style={{
                backgroundColor: selected ? "var(--surface-sunken)" : "transparent",
                border: `1px solid ${selected ? option.color : "var(--border)"}`,
                color: selected ? option.color : "var(--text-muted)",
              }}
            >
              <LordIcon
                name={option.icon}
                size={22}
                trigger="hover"
                target={`#felt-${option.key}`}
                color={selected ? option.color : "var(--text-faint)"}
              />
              {option.label}
            </button>
          );
        })}
      </div>

      {/* Only asked when it matters: "just right" has no stage to blame. */}
      <div
        className="grid transition-[grid-template-rows] duration-base ease-snap"
        style={{ gridTemplateRows: needsWhen ? "1fr" : "0fr" }}
      >
        <div className="overflow-hidden">
          <p
            className="pt-4 text-xs font-semibold"
            style={{ color: "var(--text-muted)" }}
          >
            When?
          </p>
          <div className="mt-2 flex flex-wrap gap-2" role="radiogroup" aria-label="When it felt that way">
            {WHEN.map((option) => {
              const selected = when === option.key;
              return (
                <button
                  key={option.key}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => setWhen(option.key)}
                  className="rounded-full px-3 py-1.5 text-xs font-semibold transition-colors duration-fast ease-snap"
                  style={{
                    backgroundColor: selected ? "var(--accent)" : "transparent",
                    border: `1px solid ${selected ? "var(--accent)" : "var(--border)"}`,
                    color: selected ? "var(--accent-ink)" : "var(--text-muted)",
                  }}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="mt-4 flex items-center gap-2">
        <button
          type="button"
          disabled={!canSubmit || submit.isPending}
          onClick={() =>
            submit.mutate({
              night: data.night,
              felt: felt!,
              whenFelt: needsWhen ? when : null,
              note: null,
            })
          }
          className="btn btn-primary flex-1"
        >
          {submit.isPending ? "Saving…" : "Save how it felt"}
        </button>
      </div>
      {submit.isError && (
        <p className="mt-2 text-sm" style={{ color: "var(--danger)" }}>
          {submit.error.message}
        </p>
      )}
    </section>
  );
};
