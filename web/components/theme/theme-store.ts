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
export type Accent = "blue" | "teal" | "magenta" | "slate";

export interface ThemeState {
  theme: Theme;
  accent: Accent;
}

export const THEME_KEY = "ns-theme";
export const ACCENT_KEY = "ns-accent";

const ACCENTS: readonly Accent[] = ["blue", "teal", "magenta", "slate"];

// Stable reference — required by useSyncExternalStore for the server snapshot.
const SERVER_SNAPSHOT: ThemeState = { theme: "light", accent: "blue" };

let state: ThemeState = SERVER_SNAPSHOT;
let adopted = false;
const listeners = new Set<() => void>();

function readDom(): ThemeState {
  const el = document.documentElement;
  const accent = el.getAttribute("data-accent") as Accent | null;
  return {
    theme: el.classList.contains("dark") ? "dark" : "light",
    accent: accent && ACCENTS.includes(accent) ? accent : "blue",
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

// Applies a new state to <html>, persists it, and notifies subscribers. Only
// called from explicit user actions, so adoption above never writes storage.
function commit(next: ThemeState) {
  state = next;
  const el = document.documentElement;
  el.classList.toggle("dark", next.theme === "dark");
  el.setAttribute("data-accent", next.accent);
  try {
    localStorage.setItem(THEME_KEY, next.theme);
    localStorage.setItem(ACCENT_KEY, next.accent);
  } catch {}
  emit();
}

export function setTheme(theme: Theme) {
  commit({ ...state, theme });
}

export function toggleTheme() {
  commit({ ...state, theme: state.theme === "dark" ? "light" : "dark" });
}

export function setAccent(accent: Accent) {
  commit({ ...state, accent });
}
