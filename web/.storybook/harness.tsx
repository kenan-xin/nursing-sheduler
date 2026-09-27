import type { Decorator } from "@storybook/nextjs-vite";
import { QueryClientProvider } from "@tanstack/react-query";
import { useLayoutEffect, useState } from "react";
import { Toaster } from "sonner";
import type { StoreApi } from "zustand";
import { createQueryClient } from "@/app/providers";
import { useConfirmStore } from "@/components/shell/confirm-store";
import { clearGuidedArrival } from "@/components/shell/guided-arrival";
import { useNavGuardStore } from "@/components/shell/nav-guard-store";
import { useSideCollapseStore } from "@/components/shell/side-collapse";
import { ThemeProvider, useTheme } from "@/components/theme/theme-provider";
import {
  ACCENTS,
  DEFAULT_ACCENT,
  setAccent,
  setTheme,
  type Accent,
  type Theme,
} from "@/components/theme/theme-store";
import { useChangeHighlightStore } from "@/lib/change-highlight/store";
import { useModeStore } from "@/lib/mode/mode";
import { useRunRequestStore } from "@/lib/optimize/run-request";
import { useRosterChangeStore } from "@/lib/roster/change-request";
import type { ScenarioUiState } from "@/lib/scenario";
import { useCoverEditStore } from "@/lib/scenario/cover-edit-request";
import { drainScenarioCommands, scenarioCommands, useHotStore } from "@/lib/store";
import {
  clearTestAuthority,
  installTestAuthority,
  resetProjection,
  type TestAuthority,
} from "@/lib/store/test-authority";

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

function resetStore<T>(store: StoreApi<T>): void {
  store.setState(store.getInitialState(), true);
}

/**
 * Global `beforeEach` (preview.tsx): every module-singleton UI store back to its initial
 * state, so no story inherits the previous story's pending request, confirm dialog,
 * change highlight, app mode, side-rail collapse or pending Guided arrival. The assistant store is deliberately absent: `.storybook/` sits under
 * the assistant import boundary (Phase 5 decides AI stories).
 */
export function withResetTransientStores(): void {
  resetStore(useChangeHighlightStore);
  resetStore(useRunRequestStore);
  resetStore(useCoverEditStore);
  resetStore(useRosterChangeStore);
  resetStore(useNavGuardStore);
  resetStore(useConfirmStore);
  resetStore(useModeStore);
  resetStore(useSideCollapseStore);
  clearGuidedArrival();
  useHotStore.getState().resetEphemeral();
}

/**
 * What `parameters.scenario` holds. "empty" installs with no content; a patch is ONE
 * tracked mutate (so it leaves one Undo step); a function gets the installed harness
 * (for undo/redo history or a peer tab) and may return its own cleanup.
 */
export type ScenarioSeed =
  | "empty"
  | Partial<ScenarioUiState>
  | ((harness: TestAuthority) => Promise<void | (() => Promise<void>)>);

/**
 * Bind the app's scenario singletons to a FRESH real-Chromium IndexedDB, seed it through
 * the product's own command path, and on cleanup tear down everything the next story
 * could otherwise inherit. The unique name matters: a Storybook tab keeps IndexedDB
 * across reloads, so a fixed name would replay the last visit's scenario.
 */
export function withScenarioStore(seed: ScenarioSeed = "empty") {
  return async () => {
    const harness = await installTestAuthority({
      databaseName: `storybook-${crypto.randomUUID()}`,
    });
    let seedCleanup: void | (() => Promise<void>);
    if (typeof seed === "function") seedCleanup = await seed(harness);
    else if (seed !== "empty") await scenarioCommands.mutate(seed);
    await drainScenarioCommands();
    return async () => {
      await seedCleanup?.();
      await harness.authority.release();
      clearTestAuthority();
      resetProjection();
      useHotStore.getState().setHydrationStatus("unhydrated");
      await harness.db.delete();
    };
  };
}

/**
 * Global `beforeEach` (preview.tsx), after the transient reset: install the scenario a
 * story or its meta declares in `parameters.scenario`. A parameter, not a hook, because
 * parameters OVERRIDE per story while meta and story `beforeEach` hooks all run, which
 * would install two authorities.
 */
export function withScenarioParameter({
  parameters,
}: {
  parameters: Record<string, unknown>;
}): ReturnType<ReturnType<typeof withScenarioStore>> | undefined {
  const seed = parameters.scenario as ScenarioSeed | undefined;
  return seed === undefined ? undefined : withScenarioStore(seed)();
}

function StoryToaster() {
  const { theme } = useTheme();
  // Mirrors the app shell's <Toaster> (components/shell/app-shell.tsx) and DESIGN.md §5 Toast.
  return (
    <Toaster
      theme={theme}
      position="bottom-center"
      className="ns-sonner"
      toastOptions={{ className: "ns-toast" }}
    />
  );
}

/** Story-level decorator for components that call sonner's `toast()`. */
export const withToaster: Decorator = (Story) => (
  <>
    <Story />
    <StoryToaster />
  </>
);
