// External store backing the theme/accent axes. It exists to solve the
// hydration problem: the head script (theme-script.tsx) applies the persisted
// values to <html> before paint, but the server has no way to know them, so SSR
// and the hydration render MUST use a fixed default snapshot or React reports a
// mismatch. useSyncExternalStore gives us exactly that split:
//
//   - getServerSnapshot() → the fixed DEFAULTS (used on the server AND during the
//     client hydration render, so the first client tree matches the server tree).
//   - getSnapshot() → the live store value.
//   - subscribe() → runs only AFTER commit; on first subscribe it ADOPTS the
//     already-applied <html> state, which flips the snapshot and triggers one
//     reconciliation render so the controls (toggle label, accent selection) catch
//     up. No localStorage write happens during adoption — only explicit user
//     actions persist — so a persisted value is never clobbered.
//
// Density used to be a third axis here; it was removed (bmw.8) because the control
// was unreachable in the product UI. The 0.9 spacing/type scale it produced is
// preserved as literals in globals.css instead.

export type Theme = "light" | "dark";

// The v2 accent set (adoption record D4). The retired v1 hues — blue, magenta,
// slate — clash with the mint canvas and have NO migration mapping (D4b): a
// stored value outside this union is ignored, left untouched in storage, and
// resolves to teal in both the DOM and this store.
export type Accent = "teal" | "sage" | "rose" | "plum";

export interface ThemeState {
  theme: Theme;
  accent: Accent;
}

export const THEME_KEY = "ns-theme";
export const ACCENT_KEY = "ns-accent";

export const ACCENTS: readonly Accent[] = ["teal", "sage", "rose", "plum"];

export const DEFAULT_ACCENT: Accent = "teal";

// Stable reference — required by useSyncExternalStore for the server snapshot.
const SERVER_SNAPSHOT: ThemeState = { theme: "light", accent: DEFAULT_ACCENT };

let state: ThemeState = SERVER_SNAPSHOT;
let adopted = false;
const listeners = new Set<() => void>();

function readDom(): ThemeState {
  const el = document.documentElement;
  const accent = el.getAttribute("data-accent") as Accent | null;
  return {
    theme: el.classList.contains("dark") ? "dark" : "light",
    accent: accent && ACCENTS.includes(accent) ? accent : DEFAULT_ACCENT,
  };
}

function emit() {
  for (const listener of listeners) listener();
}

export function subscribe(callback: () => void): () => void {
  // Adopt the state the head script already applied to <html>, once, after the
  // first commit — never during render (that would race the SSR snapshot).
  if (!adopted) {
    adopted = true;
    state = readDom();
  }
  listeners.add(callback);
  return () => listeners.delete(callback);
}

export function getSnapshot(): ThemeState {
  return state;
}

export function getServerSnapshot(): ThemeState {
  return SERVER_SNAPSHOT;
}

// Applies a new state to <html>, persists ONLY the axis the user actually
// touched, and notifies subscribers. Only called from explicit user actions, so
// adoption above never writes storage.
//
// The per-axis write is the point. This used to persist both keys on every
// commit, which meant flipping the theme also wrote the accent — pinning an
// axis the user never chose. A persisted value must mean "the user picked this",
// never "the user was here once".
//
// `data-accent` carries the CHOICE, never a resolved hex: the light/dark pair for
// each accent lives in CSS selectors, so a theme toggle re-resolves --brand
// without JavaScript touching colour at all.
function commit(next: ThemeState, axis: "theme" | "accent") {
  state = next;
  const el = document.documentElement;
  el.classList.toggle("dark", next.theme === "dark");
  el.setAttribute("data-accent", next.accent);
  try {
    if (axis === "theme") localStorage.setItem(THEME_KEY, next.theme);
    else localStorage.setItem(ACCENT_KEY, next.accent);
  } catch {}
  emit();
}

export function setTheme(theme: Theme) {
  commit({ ...state, theme }, "theme");
}

export function toggleTheme() {
  commit({ ...state, theme: state.theme === "dark" ? "light" : "dark" }, "theme");
}

export function setAccent(accent: Accent) {
  commit({ ...state, accent }, "accent");
}

// Test-only reset of the module-level adoption latch. The store is a singleton by
// design (one <html>, one theme), so a suite that exercises adoption more than
// once needs a way back to the pre-mount state.
export function __resetForTests() {
  state = SERVER_SNAPSHOT;
  adopted = false;
  listeners.clear();
}
