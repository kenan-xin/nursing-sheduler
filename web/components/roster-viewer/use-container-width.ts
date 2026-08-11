"use client";

// Container-width observer (F4).
//
// DESIGN.md and the F4 ticket require responsiveness based on the ROSTER
// CONTAINER's available width, not the viewport alone: a future docked assistant
// may narrow the roster surface while the viewport stays wide. Coverage stacks
// below 760px of roster content; Grid keeps scrolling inside its own card; and
// controls wrap without page-level overflow.
//
// This hook observes a ref'd element's width via `ResizeObserver` and reports
// whether it is below the 760px stacking threshold. The initial render falls
// back to the viewport width so a narrow phone defaults to stacked/Day before
// the observer fires.

import { useCallback, useEffect, useRef, useState } from "react";

/** The roster-content width below which Coverage stacks into per-day cards. */
export const COVERAGE_STACK_THRESHOLD = 760;

/**
 * The roster-content width at and above which the Grid legend renders its full
 * wrapped key inline; below it the same complete key moves behind a `Shift key`
 * disclosure (G8).
 *
 * 900 is a LAYOUT-ladder step (DESIGN.md §1: 600/720/760/900/1100/1200), not a
 * type-ladder one. Ward 8's sixteen authored ids plus Leave and Off/rest need
 * roughly two wrapped rows at 900px and four or more below it, which is the
 * point at which an always-open key starts pushing the roster off screen.
 */
export const LEGEND_WRAP_THRESHOLD = 900;

/** The viewport width below which mobile defaults to the Day lens. */
export const MOBILE_DEFAULT_LENS_VIEWPORT = 760;

export interface ContainerWidth {
  /** The observed element's content-box width in CSS pixels, or null pre-mount. */
  width: number | null;
  /** Whether the roster content is below the Coverage stacking threshold. */
  stacked: boolean;
}

function viewportWidth(): number {
  return typeof window !== "undefined" ? window.innerWidth : 1200;
}

/**
 * Observe one element's width and report whether Coverage should stack.
 *
 * Returns a `ref` callback to attach to the roster container, plus the current
 * `{ width, stacked }`. The initial render uses the viewport-based guess so a
 * narrow phone defaults to stacked/Day before the observer fires.
 */
export function useContainerWidth(): {
  ref: (element: HTMLElement | null) => void;
  width: ContainerWidth;
} {
  const [observedWidth, setObservedWidth] = useState<number | null>(null);
  const elementRef = useRef<HTMLElement | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);

  const ref = useCallback((element: HTMLElement | null) => {
    // Tear down any observer on the previous element.
    if (observerRef.current !== null) {
      observerRef.current.disconnect();
      observerRef.current = null;
    }
    elementRef.current = element;
    if (element === null) {
      setObservedWidth(null);
      return;
    }
    setObservedWidth(element.getBoundingClientRect().width);

    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (entry !== undefined) {
          setObservedWidth(entry.contentRect.width);
        }
      });
      observer.observe(element);
      observerRef.current = observer;
    }
  }, []);

  useEffect(() => {
    return () => {
      if (observerRef.current !== null) {
        observerRef.current.disconnect();
        observerRef.current = null;
      }
    };
  }, []);

  const width: ContainerWidth = {
    width: observedWidth,
    stacked: (observedWidth ?? viewportWidth()) < COVERAGE_STACK_THRESHOLD,
  };

  return { ref, width };
}
