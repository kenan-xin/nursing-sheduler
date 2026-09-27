import type { Decorator } from "@storybook/nextjs-vite";
import { expect, spyOn, waitFor } from "storybook/test";

// Long-text story helpers (bead w0e.3; bd memory `long-user-text-no-overflow`). Read-only for
// story authors: one definition, so every LongText story tests the same inputs.

/** 120 characters, no whitespace: word wrapping cannot contain it, only truncation or overflow-wrap can. */
export const LONG_TOKEN = "ward8-east-extended-weekend-night-cover-rotation-"
  .repeat(3)
  .slice(0, 120);

/** A long, spaced, user-entered description. */
export const LONG_PROSE =
  "Senior nurses on the east wing must not work more than three consecutive long days during the winter pressures period, except by prior agreement with the ward manager";

/**
 * A fixed 320px frame. Under the default `centered` layout a component otherwise sizes to its
 * own content, so an overflow would never be measurable.
 */
export const withNarrowFrame: Decorator = (Story) => (
  <div data-testid="narrow-frame" className="w-80">
    <Story />
  </div>
);

/** Fails when any descendant paints past `el`'s right edge (scrollWidth counts visible overflow). */
export async function expectNoHorizontalOverflow(el: HTMLElement): Promise<void> {
  await expect(el.scrollWidth).toBeLessThanOrEqual(el.clientWidth);
}

// Per-story fetch router (bead w0e.6). Routes match by path prefix, first match wins. Any other
// same-origin `/api/` call REJECTS so a story can never reach a backend by accident; anything
// else (Vite, Storybook assets) passes through untouched.
export type FetchRoute = readonly [
  prefix: string,
  respond: (path: string, init?: RequestInit) => Response | Promise<Response>,
];

/** A story `beforeEach` that routes `fetch` for the story and restores it afterwards. */
export function withFetchRoutes(routes: readonly FetchRoute[]) {
  return () => {
    const passThrough = globalThis.fetch;
    const spy = spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = url.startsWith(location.origin) ? url.slice(location.origin.length) : url;
      const route = routes.find(([prefix]) => path.startsWith(prefix));
      if (route) return route[1](path, init);
      if (path.startsWith("/api/")) throw new Error(`unexpected fetch in story: ${path}`);
      return passThrough(input, init);
    });
    return () => spy.mockRestore();
  };
}

/**
 * Click a FullCalendar day cell. Its `dateClick` hit-tests the pointer's page coordinates, and a
 * synthetic user-event click lands at (0, 0), so this dispatches mousedown/mouseup at the cell's
 * real centre (what Playwright's real click does in e2e/dates.spec.ts).
 */
export async function clickCalendarDay(root: HTMLElement, iso: string): Promise<void> {
  const selector = `.fc-day[data-ns-date="${iso}"]`;
  await waitFor(() => expect(root.querySelector(selector)).not.toBeNull());
  const cell = root.querySelector<HTMLElement>(selector)!;
  cell.scrollIntoView({ block: "center" });
  const box = cell.getBoundingClientRect();
  const init = {
    bubbles: true,
    cancelable: true,
    button: 0,
    view: window,
    clientX: box.x + box.width / 2,
    clientY: box.y + box.height / 2,
  };
  cell.dispatchEvent(new MouseEvent("mousedown", init));
  cell.dispatchEvent(new MouseEvent("mouseup", init));
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A text/event-stream body that delivers `text` and closes (the unit tests' `streamResponse`). */
export function sseResponse(text: string): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}
