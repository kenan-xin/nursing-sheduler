"use client";

import { createContext, useContext, useSyncExternalStore } from "react";
import {
  getServerSnapshot,
  getSnapshot,
  setAccent,
  setDensity,
  setTheme,
  subscribe,
  toggleTheme,
  type Accent,
  type Density,
  type Theme,
} from "@/components/theme/theme-store";

// Class-based light/dark + density + accent provider. All the hydration-safety
// logic lives in theme-store.ts; this is a thin context wrapper over
// useSyncExternalStore so the initial paint (head script) and the reconciliation
// after mount stay consistent. next-themes is intentionally not used.

interface ThemeContextValue {
  theme: Theme;
  density: Density;
  accent: Accent;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
  setDensity: (density: Density) => void;
  setAccent: (accent: Accent) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const { theme, density, accent } = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );

  return (
    <ThemeContext.Provider
      value={{ theme, density, accent, setTheme, toggleTheme, setDensity, setAccent }}
    >
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within <ThemeProvider>");
  return ctx;
}

export type { Accent, Density, Theme };
