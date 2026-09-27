import type { Decorator } from "@storybook/nextjs-vite";
import { QueryClientProvider } from "@tanstack/react-query";
import { useLayoutEffect, useState } from "react";
import { createQueryClient } from "@/app/providers";
import { ThemeProvider } from "@/components/theme/theme-provider";
import {
  ACCENTS,
  DEFAULT_ACCENT,
  setAccent,
  setTheme,
  type Accent,
  type Theme,
} from "@/components/theme/theme-store";

// The Storybook harness (bead w0e.2). Decorators wrap rendering; the `with*` helpers that
// set up STATE are story `beforeEach` functions, because that setup is async and needs a
// cleanup.

function QueryFrame({ children }: { children: React.ReactNode }) {
  const [client] = useState(createQueryClient);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** A fresh QueryClient per story, with the app's defaults. Global (preview.tsx). */
export const withQueryClient: Decorator = (Story, { id }) => (
  <QueryFrame key={id}>
    <Story />
  </QueryFrame>
);

function ThemeGlobals({ theme, accent }: { theme: Theme; accent: Accent }) {
  // Drives the REAL store, so <html class="dark" data-accent>, the store snapshot and any
  // ThemeToggle inside the story agree. Runs on every story mount and globals change, so no
  // story inherits the previous one's theme. Writes localStorage on the Storybook origin only.
  useLayoutEffect(() => {
    setTheme(theme);
    setAccent(accent);
  }, [theme, accent]);
  return null;
}

/** Applies the toolbar `theme` / `accent` globals through the app's ThemeProvider. Global. */
export const withTheme: Decorator = (Story, { globals }) => {
  const theme: Theme = globals.theme === "dark" ? "dark" : "light";
  const accent: Accent = ACCENTS.includes(globals.accent) ? globals.accent : DEFAULT_ACCENT;
  return (
    <ThemeProvider>
      <ThemeGlobals theme={theme} accent={accent} />
      <Story />
    </ThemeProvider>
  );
};
