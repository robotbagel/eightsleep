"use client";
import React, { useEffect } from "react";

/**
 * Date pager for the night view. Icons always carry a label (canon §10) and
 * the same navigation is reachable by tap, by swipe (see useSwipe) and by the
 * left/right arrow keys.
 */
export const NightNav: React.FC<{
  night: string | null;
  isLatest: boolean;
  canPrev: boolean;
  canNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  onLatest: () => void;
}> = ({ night, isLatest, canPrev, canNext, onPrev, onNext, onLatest }) => {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)
      ) {
        return;
      }
      if (event.key === "ArrowLeft" && canPrev) onPrev();
      if (event.key === "ArrowRight" && canNext) onNext();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canPrev, canNext, onPrev, onNext]);

  const label = night
    ? new Date(`${night}T12:00:00Z`).toLocaleDateString("en-GB", {
        weekday: "long",
        day: "numeric",
        month: "long",
      })
    : "No night selected";

  return (
    <div className="flex items-center justify-between gap-2">
      <div>
        <div className="flex items-baseline gap-2">
          <span
            className="text-[15px] font-semibold"
            style={{ color: "var(--text-headline)" }}
          >
            {isLatest ? "Last night" : label}
          </span>
          {isLatest && night && (
            <span className="text-xs" style={{ color: "var(--text-muted)" }}>
              {label}
            </span>
          )}
        </div>
        <p className="mt-0.5 text-xs" style={{ color: "var(--text-faint)" }}>
          Swipe or use the arrows to step back through your nights.
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {!isLatest && (
          <button
            type="button"
            onClick={onLatest}
            className="btn btn-ghost px-2 text-xs font-semibold"
          >
            Latest
          </button>
        )}
        <NavButton
          label="Show the night before"
          disabled={!canPrev}
          onClick={onPrev}
          direction="prev"
        />
        <NavButton
          label="Show the night after"
          disabled={!canNext}
          onClick={onNext}
          direction="next"
        />
      </div>
    </div>
  );
};

const NavButton: React.FC<{
  label: string;
  disabled: boolean;
  onClick: () => void;
  direction: "prev" | "next";
}> = ({ label, disabled, onClick, direction }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    aria-label={label}
    title={label}
    className="btn btn-secondary h-9 w-9 px-0"
  >
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden="true"
      style={{
        transform: direction === "next" ? "rotate(180deg)" : undefined,
      }}
    >
      <path
        d="M9 2.5 4.5 7 9 11.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  </button>
);
