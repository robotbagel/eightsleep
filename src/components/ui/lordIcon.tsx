"use client";
import { useEffect, useRef, useState } from "react";

// Grunkicon animated icons (Lottie JSON bundled under /public/lottie).
// Canonical wrapper — see ~/.claude/reference/grunkicon-implementation.md.
// The `colors` attribute resolves neither var() nor currentColor, so this
// wrapper resolves CSS custom properties itself and re-resolves whenever the
// theme attribute flips.

let registering: Promise<void> | null = null;

function ensureRegistered(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (!registering) {
    registering = (async () => {
      try {
        // @lordicon/element 2.3.1 bundles its own player, so defineElement()
        // takes no arguments here (older docs pass lottie-web's loadAnimation).
        const element = await import("@lordicon/element");
        if (!customElements.get("lord-icon")) element.defineElement();
      } catch (error) {
        // An icon must never take the view down with it.
        console.warn("lord-icon registration failed", error);
      }
    })();
  }
  return registering;
}

export type LordTrigger =
  | "hover"
  | "click"
  | "loop"
  | "loop-on-hover"
  | "morph"
  | "boomerang"
  | "sequence"
  | "in";

interface LordIconProps {
  /** File stem under /public/lottie (e.g. "moon"). */
  name: string;
  size?: number;
  trigger?: LordTrigger;
  /** Hex, or "var(--token)" — resolved here because lord-icon cannot. */
  color?: string;
  colorSecondary?: string;
  /** Ancestor selector: hovering IT plays the icon (glyph-sized hitboxes are a bug). */
  target?: string;
  title?: string;
  className?: string;
  style?: React.CSSProperties;
}

/** lord-icon's `colors` attribute takes a LITERAL hex — it resolves neither
 *  var() nor currentColor. Resolve tokens here so call sites stay themeable. */
function resolveColor(raw: string): string {
  if (typeof window === "undefined" || !raw.startsWith("var(")) return raw;
  const token = raw.slice(4, -1).split(",")[0]!.trim();
  return (
    getComputedStyle(document.documentElement).getPropertyValue(token).trim() ||
    "#8a7cf0"
  );
}

export default function LordIcon({
  name,
  size = 18,
  trigger = "hover",
  color = "var(--text-muted)",
  colorSecondary,
  target,
  title,
  className,
  style,
}: LordIconProps) {
  const ref = useRef<HTMLElement | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void ensureRegistered().then(() => {
      if (cancelled) return;
      const node = ref.current as (HTMLElement & {
        connectedCallback?: () => void;
      }) | null;
      if (node?.connectedCallback) {
        try {
          node.connectedCallback();
        } catch {
          /* noop */
        }
      }
      setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Colours are written imperatively rather than through JSX: they can only be
  // resolved once the stylesheet has applied, and they must be rewritten when
  // the theme attribute flips.
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const paint = () => {
      const primary = resolveColor(color);
      const secondary = colorSecondary
        ? resolveColor(colorSecondary)
        : undefined;
      node.setAttribute(
        "colors",
        secondary
          ? `primary:${primary},secondary:${secondary}`
          : `primary:${primary}`,
      );
    };
    paint();
    const observer = new MutationObserver(paint);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, [color, colorSecondary, ready]);

  return (
    <lord-icon
      ref={ref}
      src={`/lottie/${name}.json`}
      trigger={trigger}
      {...(target ? { target } : {})}
      class={className}
      title={title}
      aria-hidden={title ? undefined : true}
      style={{
        width: size,
        height: size,
        display: "inline-block",
        flexShrink: 0,
        ...style,
      }}
    />
  );
}
