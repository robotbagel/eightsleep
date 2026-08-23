"use client";
import React, { useCallback, useEffect, useRef } from "react";

/**
 * Motion canon §10: three exits (X, Esc, backdrop), focus trapped while open
 * and returned on close, destructive copy names the object and the cost, and
 * the safe choice is the visually loud default. Bottom sheet on phones,
 * centred dialog from a tablet up.
 */
export const ConfirmDialog: React.FC<{
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}> = ({
  open,
  title,
  body,
  confirmLabel,
  cancelLabel = "Keep it",
  onConfirm,
  onCancel,
}) => {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const safeRef = useRef<HTMLButtonElement | null>(null);
  const returnFocusTo = useRef<HTMLElement | null>(null);

  const trap = useCallback((event: KeyboardEvent) => {
    if (event.key !== "Tab" || !panelRef.current) return;
    const focusable = panelRef.current.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    returnFocusTo.current = document.activeElement as HTMLElement | null;
    safeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
      trap(event);
    };
    document.addEventListener("keydown", onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
      returnFocusTo.current?.focus();
    };
  }, [open, onCancel, trap]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center sm:items-center"
      style={{ animation: "fadeIn var(--motion-fast) var(--ease-out-snap)" }}
    >
      <button
        type="button"
        aria-label="Close"
        onClick={onCancel}
        className="absolute inset-0 cursor-default"
        style={{ backgroundColor: "rgba(4, 6, 14, 0.66)" }}
      />
      <div
        ref={panelRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-body"
        className="relative w-full max-w-sm rounded-t-2xl border p-5 shadow-pop sm:rounded-2xl"
        style={{
          backgroundColor: "var(--surface-raised)",
          borderColor: "var(--border-strong)",
          paddingBottom: "max(1.25rem, env(safe-area-inset-bottom))",
          animation:
            "rise var(--motion-base) var(--ease-out-expo) both",
        }}
      >
        <div className="flex items-start justify-between gap-3">
          <h2
            id="confirm-title"
            className="text-base font-semibold"
            style={{ color: "var(--text-headline)" }}
          >
            {title}
          </h2>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Close"
            className="btn btn-ghost -mr-1 -mt-1"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path
                d="M3 3l8 8M11 3l-8 8"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
        <p
          id="confirm-body"
          className="mt-2 text-sm leading-relaxed"
          style={{ color: "var(--text-muted)" }}
        >
          {body}
        </p>
        <div className="mt-5 flex gap-2">
          <button
            ref={safeRef}
            type="button"
            onClick={onCancel}
            className="btn btn-primary flex-1"
          >
            {cancelLabel}
          </button>
          <button type="button" onClick={onConfirm} className="btn btn-danger">
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};
