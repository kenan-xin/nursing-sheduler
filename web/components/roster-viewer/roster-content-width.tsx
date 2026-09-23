"use client";

// The ONE roster-content width authority (G7).
//
// Responsive behaviour on this route is keyed to the width of the roster CONTENT,
// not the viewport: a future docked assistant may narrow the roster while the
// viewport stays wide. That was already true of the lens surfaces, but the
// document action row sat ABOVE the measured element and had no width at all — so
// the actions and the data could disagree about how narrow "narrow" is, and a
// second `useContainerWidth()` on the action row would have made two independent
// measurements of the same box.
//
// This provider is the single measurement. It wraps the action row AND the lens/
// data surface, and both read the same value.

import { createContext, useContext, type ReactNode } from "react";
import { useContainerWidth, type ContainerWidth } from "./use-container-width";

/**
 * The pre-mount fallback. Production always renders inside the provider, so this
 * only serves a consumer mounted on its own (a focused component test); it is a
 * conservative desktop guess, never a second measurement of a real element.
 */
const FALLBACK: ContainerWidth = { width: null, stacked: false };

const RosterContentWidthContext = createContext<ContainerWidth>(FALLBACK);

/** The measured roster-content width. */
export function useRosterContentWidth(): ContainerWidth {
  return useContext(RosterContentWidthContext);
}

export interface RosterContentWidthProviderProps {
  children: ReactNode;
  className?: string;
}

/**
 * Measure the roster content box once and publish it to everything inside.
 *
 * `min-w-0` is load-bearing: a scrolling data panel inside a default
 * `min-width:auto` flex item pushes the DOCUMENT into horizontal scroll instead
 * of scrolling itself (DESIGN.md §6 rule 6).
 */
export function RosterContentWidthProvider({
  children,
  className,
}: RosterContentWidthProviderProps) {
  const { ref, width } = useContainerWidth();
  return (
    <div ref={ref} data-testid="roster-content" className={className}>
      <RosterContentWidthContext.Provider value={width}>
        {children}
      </RosterContentWidthContext.Provider>
    </div>
  );
}
