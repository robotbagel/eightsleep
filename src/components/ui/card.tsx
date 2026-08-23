"use client";
import React, { useId, useState } from "react";
import LordIcon from "./lordIcon";

export const Card: React.FC<{
  children: React.ReactNode;
  className?: string;
  index?: number;
  padded?: boolean;
}> = ({ children, className = "", index = 0, padded = true }) => (
  <section
    className={`card enter ${padded ? "p-5" : ""} ${className}`}
    style={{ "--i": index } as React.CSSProperties}
  >
    {children}
  </section>
);

export const CardHeader: React.FC<{
  icon?: string;
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
  iconColor?: string;
}> = ({ icon, title, subtitle, right, iconColor = "var(--accent)" }) => {
  const id = useId().replace(/:/g, "");
  return (
    <div id={`hdr-${id}`} className="mb-4 flex items-start justify-between gap-3">
      <div className="flex items-center gap-2.5">
        {icon && (
          <LordIcon
            name={icon}
            size={22}
            trigger="hover"
            target={`#hdr-${id}`}
            color={iconColor}
            colorSecondary="var(--text-muted)"
          />
        )}
        <div>
          <h2 className="card-title">{title}</h2>
          {subtitle && (
            <p className="mt-0.5 text-sm" style={{ color: "var(--text-muted)" }}>
              {subtitle}
            </p>
          )}
        </div>
      </div>
      {right}
    </div>
  );
};

/**
 * Progressive disclosure for the settings-shaped parts of the app, so the
 * data stays at the top and the knobs stay out of the way until wanted.
 */
export const Disclosure: React.FC<{
  icon?: string;
  title: string;
  summary?: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
  index?: number;
}> = ({ icon, title, summary, defaultOpen = false, children, index = 0 }) => {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId().replace(/:/g, "");

  return (
    <section
      className="card enter overflow-hidden"
      style={{ "--i": index } as React.CSSProperties}
    >
      <button
        id={`disc-${id}`}
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls={`panel-${id}`}
        className="group flex w-full items-center justify-between gap-3 p-5 text-left transition-colors duration-fast ease-snap hover:bg-[var(--surface-hover)]"
      >
        <span className="flex items-center gap-2.5">
          {icon && (
            <LordIcon
              name={icon}
              size={22}
              trigger="hover"
              target={`#disc-${id}`}
              color="var(--accent)"
              colorSecondary="var(--text-muted)"
            />
          )}
          <span>
            <span className="card-title block">{title}</span>
            {summary && (
              <span
                className="mt-0.5 block text-sm"
                style={{ color: "var(--text-muted)" }}
              >
                {summary}
              </span>
            )}
          </span>
        </span>
        <span
          className="grid h-7 w-7 shrink-0 place-items-center rounded-full transition-transform duration-fast ease-snap group-hover:translate-y-0.5"
          style={{
            backgroundColor: "var(--surface-sunken)",
            transform: open ? "rotate(180deg)" : undefined,
          }}
          aria-hidden="true"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path
              d="M2.5 4.5 6 8l3.5-3.5"
              stroke="var(--text-muted)"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      </button>

      <div
        id={`panel-${id}`}
        className="grid transition-[grid-template-rows] duration-base ease-snap"
        style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
      >
        <div className="overflow-hidden">
          <div className="border-t px-5 py-5" style={{ borderColor: "var(--border)" }}>
            {children}
          </div>
        </div>
      </div>
    </section>
  );
};

export const Tile: React.FC<{
  icon?: string;
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  children?: React.ReactNode;
  color?: string;
}> = ({ icon, label, value, sub, children, color = "var(--text-muted)" }) => {
  const id = useId().replace(/:/g, "");
  return (
    <div id={`tile-${id}`} className="tile">
      <div className="tile-label">
        {icon && (
          <LordIcon
            name={icon}
            size={14}
            trigger="hover"
            target={`#tile-${id}`}
            color={color}
          />
        )}
        {label}
      </div>
      <div className="tile-value">{value}</div>
      {sub && <div className="tile-sub">{sub}</div>}
      {children}
    </div>
  );
};

export const Skeleton: React.FC<{ className?: string }> = ({ className = "" }) => (
  <div className={`skeleton ${className}`} />
);
