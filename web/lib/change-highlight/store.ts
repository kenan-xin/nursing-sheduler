// Which rows a just-applied change should outline, for a few seconds.
//
// The one seam between the assistant's Apply and the scheduling screens. The Apply
// notice writes here after it has navigated; a screen's rows read here through
// `useChangeTarget`. It lives in lib/, not lib/ai, because scheduling code may never
// import assistant code (`.oxlintrc.json`, "AI IS OPTIONAL") -- the same reason
// `lib/optimize/run-request.ts` lives where it does.
//
// Screens render the KEY always and the HIGHLIGHT only while it is live, so the
// attribute is a stable target id and not a styling toggle a re-skin could drop.

import { create } from "zustand";

// ponytail: fixed duration. Make it a setting only if users ask for longer.
export const CHANGE_HIGHLIGHT_MS = 5_000;
export const CHANGE_TARGET_ATTRIBUTE = "data-change-key";
export const CHANGE_HIGHLIGHT_ATTRIBUTE = "data-change-highlight";
export const CHANGE_HIGHLIGHT_SELECTOR = `[${CHANGE_HIGHLIGHT_ATTRIBUTE}="true"]`;

const NONE: ReadonlySet<string> = new Set();

export const useChangeHighlightStore = create<{ keys: ReadonlySet<string> }>()(() => ({
  keys: NONE,
}));

let timer: ReturnType<typeof setTimeout> | undefined;

export function clearChangeHighlight(): void {
  clearTimeout(timer);
  timer = undefined;
  useChangeHighlightStore.setState({ keys: NONE });
}

export function showChangeHighlight(
  keys: readonly string[],
  durationMs: number = CHANGE_HIGHLIGHT_MS,
): void {
  clearTimeout(timer);
  useChangeHighlightStore.setState({ keys: new Set(keys) });
  timer = setTimeout(clearChangeHighlight, durationMs);
}

export function changeTargetProps(
  key: string | undefined,
  highlighted: boolean,
): Record<string, string> {
  if (key === undefined) return {};
  return highlighted
    ? { [CHANGE_TARGET_ATTRIBUTE]: key, [CHANGE_HIGHLIGHT_ATTRIBUTE]: "true" }
    : { [CHANGE_TARGET_ATTRIBUTE]: key };
}

/** Spread on the row: `<tr {...useChangeTarget(changeKeys.person(item.id))}>`. */
export function useChangeTarget(key: string | undefined): Record<string, string> {
  const highlighted = useChangeHighlightStore((state) => key !== undefined && state.keys.has(key));
  return changeTargetProps(key, highlighted);
}

/** For lists that render many targets at once (the requests matrix). */
export function useChangeHighlightKeys(): ReadonlySet<string> {
  return useChangeHighlightStore((state) => state.keys);
}
