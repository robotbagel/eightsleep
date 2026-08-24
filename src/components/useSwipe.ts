"use client";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Horizontal swipe with drag-follow, for paging between nights.
 *
 * Motion canon §3: touch-driven physics is one of the few places a spring
 * belongs, so the released card settles with `spring-drag-release` rather than
 * a plain ease. The pointer is only captured once the gesture is clearly
 * horizontal, so vertical page scrolling is never stolen.
 */
export interface SwipeState {
  /** Live horizontal offset in px while dragging; 0 at rest. */
  dx: number;
  dragging: boolean;
  /** Direction the last committed swipe went, for the entrance animation. */
  entering: "prev" | "next" | null;
  bind: {
    onPointerDown: (event: React.PointerEvent) => void;
    onPointerMove: (event: React.PointerEvent) => void;
    onPointerUp: (event: React.PointerEvent) => void;
    onPointerCancel: (event: React.PointerEvent) => void;
  };
}

const COMMIT_PX = 56;
const CLAIM_PX = 10;

export function useSwipe({
  onPrev,
  onNext,
  canPrev = true,
  canNext = true,
  enabled = true,
}: {
  onPrev: () => void;
  onNext: () => void;
  canPrev?: boolean;
  canNext?: boolean;
  enabled?: boolean;
}): SwipeState {
  const [dx, setDx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [entering, setEntering] = useState<"prev" | "next" | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const claimed = useRef(false);
  // The commit decision reads the offset from a ref, never from state: a fast
  // flick can deliver its last move and its pointerup inside one task, and
  // React will not have re-rendered in between, so the state copy is stale.
  const dxRef = useRef(0);

  useEffect(() => {
    if (entering == null) return;
    const timer = setTimeout(() => setEntering(null), 320);
    return () => clearTimeout(timer);
  }, [entering]);

  const reset = useCallback(() => {
    origin.current = null;
    claimed.current = false;
    dxRef.current = 0;
    setDragging(false);
    setDx(0);
  }, []);

  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      if (!enabled || event.pointerType === "mouse") return;
      origin.current = { x: event.clientX, y: event.clientY };
      claimed.current = false;
    },
    [enabled],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent) => {
      const start = origin.current;
      if (!start) return;
      const deltaX = event.clientX - start.x;
      const deltaY = event.clientY - start.y;

      if (!claimed.current) {
        // Let a vertical scroll win outright; only claim a clearly sideways drag.
        if (Math.abs(deltaY) > Math.abs(deltaX)) {
          origin.current = null;
          return;
        }
        if (Math.abs(deltaX) < CLAIM_PX) return;
        claimed.current = true;
        setDragging(true);
        event.currentTarget.setPointerCapture?.(event.pointerId);
      }

      // Swiping right goes back in time; resist when there is nothing there.
      const blocked = deltaX > 0 ? !canPrev : !canNext;
      const next = blocked ? deltaX * 0.25 : deltaX;
      dxRef.current = next;
      setDx(next);
    },
    [canNext, canPrev],
  );

  const onPointerUp = useCallback(() => {
    if (!claimed.current) {
      reset();
      return;
    }
    const travelled = dxRef.current;
    if (travelled > COMMIT_PX && canPrev) {
      setEntering("prev");
      onPrev();
    } else if (travelled < -COMMIT_PX && canNext) {
      setEntering("next");
      onNext();
    }
    reset();
  }, [canPrev, canNext, onPrev, onNext, reset]);

  return {
    dx,
    dragging,
    entering,
    bind: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: reset,
    },
  };
}
