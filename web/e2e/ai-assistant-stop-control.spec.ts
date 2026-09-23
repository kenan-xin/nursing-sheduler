import { expect, test, type Page } from "@playwright/test";

// THE STOP CONTROL, IN A REAL BROWSER, THROUGH THE REAL PANEL.
//
// Every turn runs on a per-turn CLONE of the panel agent, so the long-lived panel agent
// is idle for the whole run. The session used to report `isRunning` from that agent,
// and the locked `CopilotChatView` renders its Stop affordance only when `isRunning` is
// true -- so a live turn offered the user a send control while the model was working,
// and the only way to stop was an API a nurse does not have.
//
// This has to be a browser journey. The component suites cannot mount the locked view:
// it resolves `useCopilotKit` through an internal import that a module mock cannot
// intercept, and a real `CopilotKitProvider` does not resolve to the same module
// instance under vitest. Here the application supplies the provider, so the button
// under test is the shipped one.
//
// NO LIVE PROVIDER. The run request is intercepted and simply never answered, which is
// what a stuck stream is: the turn starts, the transport stays open, and nothing but
// Stop can end it.

// THE LOCKED VIEW'S OWN CONTRACT, read from the vendored 1.66.2 source rather than
// guessed: there is no separate Stop element. The composer button is the send control
// when idle and the STOP action when running (`if (isProcessing && !canSend) onStop()`),
// and the view marks its running state on the container as `data-copilot-running`.
// That attribute is rendered straight from the `isRunning` prop this panel passes --
// which is precisely the value that used to come from the idle panel agent.
const SEND_BUTTON = "copilot-send-button";
const RUNNING = '[data-copilot-running="true"]';
const NOT_RUNNING = '[data-copilot-running="false"]';

const SENTINEL_KEY = "sk-or-v1-E2E-SENTINEL-DO-NOT-LEAK-000000000000";
const SENTINEL_MODEL = "anthropic/claude-sonnet-4.5";

type NsWindow = {
  __nsStore: { authority(): { scenarioId: string | null; ownership: string } };
  __nsAssistant: {
    ready(): boolean;
    lastTurn(): Promise<{ state: string; terminalReason: string | null } | null>;
  };
};

async function stubCatalog(page: Page) {
  await page.route("**/api/ai/openrouter/models", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "cache-control": "no-store" },
      body: JSON.stringify({
        source: "catalog",
        models: [{ id: SENTINEL_MODEL, label: "Claude Sonnet 4.5" }],
      }),
    }),
  );
}

async function stubProbe(page: Page) {
  await page.route("**/api/ai/openrouter/test", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "cache-control": "no-store" },
      body: JSON.stringify({ ok: true }),
    }),
  );
}

/**
 * Hold every assistant run request open, forever.
 *
 * Never fulfilled and never aborted, so the request stays pending -- the browser's own
 * version of a model that has started answering and stopped. Returns the count so a
 * test can prove a request was actually made.
 */
function holdRuns(page: Page) {
  const held: string[] = [];
  void page.route("**/api/copilotkit/**", (route) => {
    // Only the RUN request. The `/info` handshake has to be answered or the agent
    // never becomes ready and the send is refused before a turn exists.
    if (!route.request().url().includes("/run")) {
      void route.continue();
      return;
    }
    held.push(route.request().url());
    // Deliberately no `fulfill`/`abort`: the stream stays open forever.
  });
  return held;
}

async function gotoReadyShell(page: Page, path: string) {
  await page.goto(path);
  await page.waitForFunction(() => {
    const ns = (window as unknown as Partial<NsWindow>).__nsStore;
    return Boolean(ns) && ns!.authority().scenarioId !== null;
  });
}

/** Enable the assistant and pass the probe, so the panel is reachable. */
async function activate(page: Page) {
  await gotoReadyShell(page, "/settings");
  await page.getByTestId("ai-enabled-switch").click();
  await page.getByTestId("ai-key-input").fill(SENTINEL_KEY);
  await page.getByTestId("ai-model-select").selectOption(SENTINEL_MODEL);
  await page.getByTestId("ai-test").click();
  await expect(page.getByTestId("ai-readiness")).toHaveText("Ready");
}

test.describe("T11 the shipped Stop control", () => {
  test.beforeEach(async ({ page }, testInfo) => {
    testInfo.setTimeout(90_000);
    await page.addInitScript(() => {
      (window as unknown as { __NS_ENABLE_TEST_BRIDGE?: boolean }).__NS_ENABLE_TEST_BRIDGE = true;
    });
  });

  test("appears during a stuck clone run, and stops it", async ({ page }) => {
    await stubCatalog(page);
    await stubProbe(page);
    await activate(page);

    const held = holdRuns(page);
    await gotoReadyShell(page, "/dates");
    await page.getByTestId("assistant-launcher").click();

    const composer = page.getByRole("textbox").last();
    await expect(composer).toBeVisible();

    // Idle: the view says so, and the composer button is the send control.
    await expect(page.locator(NOT_RUNNING).first()).toBeAttached();
    await expect(page.getByTestId(SEND_BUTTON)).toBeVisible();

    await composer.fill("why is the 15th short?");
    await composer.press("Enter");

    // THE SHIPPED AFFORDANCE, rendered by the locked view off the session's own
    // `isRunning`.
    await expect.poll(() => held.length).toBeGreaterThan(0);
    // The turn genuinely reached the transport and is genuinely stuck: the run request
    // is open and will never be answered.
    await expect.poll(() => held.length).toBeGreaterThan(0);

    // THE SHIPPED AFFORDANCE. The view now reports itself running, which is what turns
    // the composer button into Stop. Read from the idle panel agent, this stayed false
    // and the user was offered Send in the middle of a live turn.
    await expect(page.locator(RUNNING).first()).toBeAttached();
    await expect(page.locator(NOT_RUNNING)).toHaveCount(0);

    // Stop, the way a person does it.
    await page.getByTestId(SEND_BUTTON).click();

    // Running state clears and send readiness returns.
    await expect(page.locator(NOT_RUNNING).first()).toBeAttached();
    await expect(page.locator(RUNNING)).toHaveCount(0);
    await expect(page.getByTestId(SEND_BUTTON)).toBeVisible();
    await expect(composer).toBeEnabled();

    // And the turn settled truthfully rather than claiming completion.
    await expect
      .poll(async () =>
        page.evaluate(async () => {
          const turn = await (window as unknown as NsWindow).__nsAssistant.lastTurn();
          return turn?.terminalReason ?? null;
        }),
      )
      .not.toBe("completed");
  });
});
