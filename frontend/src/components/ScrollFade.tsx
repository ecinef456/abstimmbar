// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Universität Osnabrück (virtUOS)

/** Horizontal scroller with a visible affordance (#179).
 *
 * Mobile browsers hide overlay scrollbars, so content cut at the edge of an
 * `overflow-x-auto` box gives no hint that it scrolls. This wrapper fades
 * whichever edge still has content beyond it and reports `scrollable` to the
 * caller (e.g. to show a "swipe" hint). Where nothing overflows it renders
 * exactly like a plain `overflow-x-auto` div. */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

export default function ScrollFade({
  children,
  className = "",
  scrollerClassName = "",
  fadeFromClassName = "from-white dark:from-slate-950",
  onScrollableChange,
}: {
  children: ReactNode;
  /** Outer (positioned) box. */
  className?: string;
  /** The scrolling box itself (borders, rounding, …). */
  scrollerClassName?: string;
  /** Gradient start colour — the background the content sits on. */
  fadeFromClassName?: string;
  onScrollableChange?: (scrollable: boolean) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    const next = { left: el.scrollLeft > 1, right: el.scrollLeft < max - 1 };
    setEdges((prev) => (prev.left === next.left && prev.right === next.right ? prev : next));
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    return () => observer.disconnect();
  }, [update]);

  const scrollable = edges.left || edges.right;
  useEffect(() => onScrollableChange?.(scrollable), [scrollable, onScrollableChange]);

  // Inset 1px so a border on the scroller stays visible under the fade.
  const fade = `pointer-events-none absolute inset-y-px w-8 to-transparent transition-opacity ${fadeFromClassName}`;
  return (
    <div className={`relative ${className}`}>
      <div
        ref={ref}
        onScroll={update}
        // Keyboard users must be able to scroll it (axe scrollable-region-focusable).
        tabIndex={scrollable ? 0 : undefined}
        className={`overflow-x-auto ${scrollerClassName}`}
      >
        {children}
      </div>
      <span
        aria-hidden
        className={`${fade} left-px bg-gradient-to-r ${edges.left ? "opacity-100" : "opacity-0"}`}
      />
      <span
        aria-hidden
        className={`${fade} right-px bg-gradient-to-l ${edges.right ? "opacity-100" : "opacity-0"}`}
      />
    </div>
  );
}
