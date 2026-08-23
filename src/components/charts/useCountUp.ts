"use client";
import { useEffect, useRef, useState } from "react";

/**
 * Motion canon §6: numbers that change roll to their new value, they never snap
 * silently. Honours prefers-reduced-motion by jumping straight to the target.
 */
export function useCountUp(target: number | null, durationMs = 700): number {
  const [value, setValue] = useState(0);
  const frame = useRef<number | null>(null);

  useEffect(() => {
    if (target == null) {
      setValue(0);
      return;
    }
    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      setValue(target);
      return;
    }
    const from = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min((now - start) / durationMs, 1);
      // ease-out-quart, matching --ease-out-quart
      const eased = 1 - Math.pow(1 - t, 4);
      setValue(from + (target - from) * eased);
      if (t < 1) frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
    return () => {
      if (frame.current != null) cancelAnimationFrame(frame.current);
    };
  }, [target, durationMs]);

  return value;
}
