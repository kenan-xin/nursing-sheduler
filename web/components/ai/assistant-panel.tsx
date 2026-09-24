"use client";

// The app-owned dock/sheet controller (T04).
//
// RESPONSIVE ROLE, from the exploratory prototype's panel: one bordered L1 surface
// with a header identifying the assistant and its model, a conversation region, and
// an input row. Wide layouts DOCK it beside the current screen; narrow layouts open
// the same body as a full-height SHEET over the app. The prototype's
// immediate-Apply fix list is deliberately absent -- there is no Apply surface in
// T04, and the closed flows override the prototype on that point.
//
// WHY THIS IS NOT THE SHARED `Dialog`. The design system's overlay set has exactly
// two geometries (a centred modal card and a LEFT-anchored navigation drawer). A
// right-anchored sheet is a third, and adding it to the shared surface recipe would
// re-skin an authority every screen depends on for the sake of one panel. So the
// sheet is composed here from `Surface` plus layout, and the shared overlay
// primitive is left alone. It still behaves like an overlay: a scrim, Escape to
// close, and focus moved into the panel.
//
// THREAD SELECTION is the correctness boundary. The panel resolves the ACTIVE
// thread for the currently selected scenario identity and re-keys on it, so a
// load/replace (which mints a new identity upstream) can only ever produce a clean
// thread, and restoring a prior identity restores that identity's own thread.

import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { usePathname } from "next/navigation";
import { useAuthorityStore, useScenarioStore } from "@/lib/store";
import { selectActiveThread } from "@/lib/ai/assistant/history-repo";
import { assistantActions, useAssistantStore } from "@/lib/ai/assistant/store";
import { Button } from "@/components/ui/button";
import { Surface } from "@/components/ui/surface";
import { FaXmark } from "@/components/icons";
import { findNavItem } from "@/components/shell/nav-config";
import {
  AssistantHistoricalConversation,
  AssistantLiveConversation,
} from "./assistant-conversation";

/** Why the panel is read-only right now, or `null` when it is live. */
function readOnlyReason(ownership: string): string | null {
  switch (ownership) {
    case "owner":
      return null;
    case "read-only":
      return "This schedule is being edited in another tab, so this conversation is read-only. Take over editing in this tab to continue it.";
    case "taken-over":
      return "Another tab took over editing this schedule. This conversation is kept as history.";
    case "expired":
      return "This tab's editing claim expired. Take over editing again to continue the conversation.";
    default:
      return "The schedule is still loading, so this conversation is read-only for the moment.";
  }
}

/** Resolve (and create, if this identity has never had one) the active thread. */
function useActiveThreadId(scenarioId: string | null): string | null {
  const [threadId, setThreadId] = useState<string | null>(null);

  useEffect(() => {
    if (!scenarioId) {
      setThreadId(null);
      return;
    }
    let cancelled = false;
    // A purely LOCAL write. Nothing here contacts the provider, and no writer lease
    // is required: a thread row is not scenario content, so a read-only tab may
    // still open the panel and read its own history.
    void selectActiveThread(scenarioId).then((thread) => {
      if (!cancelled) setThreadId(thread.threadId);
    });
    return () => {
      cancelled = true;
    };
  }, [scenarioId]);

  return threadId;
}

function PanelBody() {
  const pathname = usePathname();
  const scenarioId = useAuthorityStore((state) => state.scenarioId);
  const ownership = useAuthorityStore((state) => state.ownership);
  const modelId = useAssistantStore((state) => state.settings.modelId);
  const scenarioName = useScenarioStore((state) => state.meta.description);
  const threadId = useActiveThreadId(scenarioId);
  const reason = readOnlyReason(ownership);

  return (
    <>
      <div className="flex shrink-0 items-start gap-3 border-b border-line2 px-4 py-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="font-heading text-cardhead font-semibold tracking-[-0.015em]">
            Schedule assistant
          </h2>
          <p className="truncate text-meta text-ink3" data-testid="assistant-panel-subtitle">
            {scenarioName || "Untitled schedule"}
            {modelId ? ` · ${modelId}` : ""}
          </p>
        </div>
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="icon"
          onClick={assistantActions.closePanel}
          data-testid="assistant-close"
        >
          <FaXmark aria-hidden />
          <span className="sr-only">Close assistant</span>
        </Button>
      </div>

      {threadId === null ? (
        <p className="p-4 text-meta text-ink2">Opening this schedule&apos;s conversation…</p>
      ) : reason ? (
        <AssistantHistoricalConversation threadId={threadId} reason={reason} />
      ) : (
        // Re-keyed on the thread: a scenario switch replaces the whole conversation
        // rather than re-pointing a live agent at a different document's thread.
        <AssistantLiveConversation
          key={threadId}
          threadId={threadId}
          routePath={pathname}
          routeLabel={findNavItem(pathname)?.label ?? null}
        />
      )}
    </>
  );
}

/**
 * The app's `nav` pivot (920px, `--breakpoint-nav` in globals.css) -- the same line
 * the shell already uses to switch between a persistent rail and an overlay drawer.
 * The assistant follows it rather than introducing a second breakpoint.
 */
export const ASSISTANT_DOCK_QUERY = "(min-width: 920px)";

/**
 * Whether the layout is wide enough to dock.
 *
 * A media QUERY rather than two CSS-hidden containers, and that is a correctness
 * requirement, not a preference: the conversation mounts a private thread-scoped
 * agent, and two of them under one thread id collide in CopilotKit's agent registry
 * (`registerProxiedAgent: agentId ... is already registered`). Rendering the body
 * once is what keeps one thread to one agent, one hydration, and one tool
 * registration.
 *
 * There is no first-paint flash to trade away for it: the panel only ever mounts
 * after hydration, in response to an explicit user action, so `matchMedia` is
 * always available by the time this runs.
 */
function useIsWideLayout(): boolean {
  const [wide, setWide] = useState(
    () => typeof window !== "undefined" && window.matchMedia(ASSISTANT_DOCK_QUERY).matches,
  );

  useEffect(() => {
    const query = window.matchMedia(ASSISTANT_DOCK_QUERY);
    const sync = () => setWide(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  return wide;
}

/**
 * The dock's user-chosen width, in px, persisted per browser. `null` means the user
 * has never dragged, and the dock keeps its `w-96` default.
 *
 * The floor sits a little under the default so the composer row still fits; the
 * ceiling is half the viewport so the screen beside it stays usable with the rail
 * open. Read in the initializer because the panel only mounts after hydration.
 */
export const ASSISTANT_DOCK_WIDTH_KEY = "ns-assistant-dock-width";
export const ASSISTANT_DOCK_MIN_WIDTH = 320;
const DOCK_KEY_STEP = 16;

function clampDockWidth(width: number): number {
  const max = Math.max(ASSISTANT_DOCK_MIN_WIDTH, Math.round(window.innerWidth / 2));
  return Math.round(Math.min(max, Math.max(ASSISTANT_DOCK_MIN_WIDTH, width)));
}

function readStoredDockWidth(): number | null {
  try {
    const stored = Number(window.localStorage.getItem(ASSISTANT_DOCK_WIDTH_KEY));
    return stored > 0 ? clampDockWidth(stored) : null;
  } catch {
    return null;
  }
}

function persistDockWidth(width: number): void {
  try {
    window.localStorage.setItem(ASSISTANT_DOCK_WIDTH_KEY, String(width));
  } catch {}
}

/**
 * The dock's inner-edge splitter. A child of the dock rather than a class on it:
 * the surface consumer's className admits neither `cursor-*` nor an arbitrary width.
 */
function DockResizeHandle({
  dockRef,
  width,
  onWidth,
}: {
  dockRef: RefObject<HTMLDivElement | null>;
  width: number | null;
  onWidth: (width: number) => void;
}) {
  const current = () => clampDockWidth(width ?? dockRef.current?.offsetWidth ?? 0);
  // The untouched default is a class, so its px value is only known after layout.
  const [defaultWidth, setDefaultWidth] = useState<number | null>(null);
  useEffect(() => {
    setDefaultWidth(clampDockWidth(dockRef.current?.offsetWidth ?? 0));
  }, [dockRef]);

  const onPointerDown = (event: ReactPointerEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = current();
    let next = startWidth;
    const move = (e: PointerEvent) => {
      // The dock is right-anchored, so moving the pointer LEFT grows it.
      next = clampDockWidth(startWidth + startX - e.clientX);
      onWidth(next);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      persistDockWidth(next);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const onKeyDown = (event: ReactKeyboardEvent) => {
    const delta =
      event.key === "ArrowLeft" ? DOCK_KEY_STEP : event.key === "ArrowRight" ? -DOCK_KEY_STEP : 0;
    if (!delta) return;
    event.preventDefault();
    const next = clampDockWidth(current() + delta);
    onWidth(next);
    persistDockWidth(next);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize assistant"
      aria-valuenow={width ?? defaultWidth ?? undefined}
      aria-valuemin={ASSISTANT_DOCK_MIN_WIDTH}
      aria-valuemax={clampDockWidth(Infinity)}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize touch-none hover:bg-brand/30 focus-visible:bg-brand/30 focus-visible:outline-none"
    />
  );
}

/** The dock (wide) and the sheet (narrow), sharing one body and one agent. */
export function AssistantPanel() {
  const wide = useIsWideLayout();
  const sheetRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const [dockWidth, setDockWidth] = useState<number | null>(readStoredDockWidth);
  const panelOpen = useAssistantStore((state) => state.panelOpen);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") assistantActions.closePanel();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  // Keyed on `wide` and `panelOpen` so the sheet takes focus whenever it APPEARS: a
  // resize across the pivot swaps the container, and a closed panel stays mounted.
  useEffect(() => {
    if (panelOpen) sheetRef.current?.focus();
  }, [wide, panelOpen]);

  // DOCK -- a sibling of the main column, so the screen narrows beside it rather
  // than being covered by it.
  //
  // No `border-l` here on purpose: the `surface` role already carries a full
  // hairline, and a consumer's className is layout-only, so the edge belongs to the
  // recipe. Flush to the viewport's top, bottom and right, the only edge that reads
  // is the one facing the content.
  //
  // `w-96` on the 0.9 baseline rather than an arbitrary pixel width: a surface
  // consumer's className admits no arbitrary value, and the dock has no reason to
  // sit off the spacing scale. A user-dragged width goes through `style`, which
  // overrides it without an arbitrary class.
  if (wide) {
    return (
      <Surface
        level="surface"
        geometry="square"
        className="relative flex w-96 shrink-0 flex-col"
        style={dockWidth === null ? undefined : { width: dockWidth }}
        ref={dockRef}
        data-testid="assistant-dock"
        aria-label="Schedule assistant"
      >
        <DockResizeHandle dockRef={dockRef} width={dockWidth} onWidth={setDockWidth} />
        <PanelBody />
      </Surface>
    );
  }

  // SHEET -- the same body over the app on a narrow layout.
  return (
    <div className="fixed inset-0 z-50 flex" data-testid="assistant-sheet">
      {/* The scrim is deliberately NOT a button: the header already publishes one
          "Close assistant" control, and a second focusable one with the same name
          gives a screen-reader user two identical stops for one action. Click-outside
          stays available as a pointer convenience, and Escape covers the keyboard. */}
      <div
        aria-hidden
        className="absolute inset-0 bg-scrim"
        onClick={assistantActions.closePanel}
      />
      {/* `surface`, not `raised`: the ladder pairs L2 with the 16px card radius, and
          a full-height sheet has to be square (DESIGN.md §5 -- a rounded corner on a
          full-bleed edge leaves a sliver of page background behind it). */}
      <Surface
        level="surface"
        geometry="square"
        className="relative ml-auto flex w-full max-w-md flex-col"
        role="dialog"
        aria-modal="true"
        aria-label="Schedule assistant"
        tabIndex={-1}
        ref={sheetRef}
      >
        <PanelBody />
      </Surface>
    </div>
  );
}
