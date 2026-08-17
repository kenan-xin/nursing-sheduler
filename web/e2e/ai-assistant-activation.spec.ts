import { expect, test, type Page } from "@playwright/test";
import { AI_SETUP_CODES } from "@/lib/ai/protocol";

// T11 acceptance: the assembled Phase-1 activation journeys, in a real browser
// against a production build and real IndexedDB.
//
// WHAT THIS LAYER ADDS over the unit and component suites, which already cover the
// same contracts against `fake-indexeddb` inside one Node process:
//
//   * OFF BY DEFAULT is a property of a FRESH BROWSER PROFILE, not of a store that a
//     test reset. Only a real first visit can show that nothing mounts, nothing is
//     stored and no provider request is made before the user asks for it.
//   * THE LATE-CALLBACK QUARANTINE spans a RELOAD. The whole reason the generation
//     fence is durable rather than an in-memory flag is that a reload destroys the
//     flag; proving it therefore needs two real page lifetimes over one database,
//     which a single-process unit test cannot produce.
//   * CREDENTIAL CONTAINMENT is a statement about the whole browser -- cookies, both
//     web storages, every other Dexie table, the DOM, and the request log. It can
//     only be checked where all of those exist.
//   * SINGLE-WRITER assistant authority needs two real tabs sharing one IndexedDB.
//
// NO LIVE PROVIDER IS USED, and none is needed: every journey below stops at the
// app's own boundary. The two same-origin setup routes are fulfilled in the browser,
// so the sentinel credential never leaves the machine and the app's own readiness,
// storage and containment behaviour is what is under test. Live-model behaviour is a
// separate release lane, recorded as such in the activation runbook.

/** Obviously fake. Any appearance outside the settings row is a leak. */
const SENTINEL_KEY = "sk-or-v1-E2E-SENTINEL-DO-NOT-LEAK-000000000000";
const SENTINEL_MODEL = "anthropic/claude-sonnet-4.5";

type AssistantSettings = {
  enabled: boolean;
  apiKey: string | null;
  modelId: string | null;
  probedAt: string | null;
};

type NsWindow = {
  __nsStore: {
    commands: { mutate(patch: Record<string, unknown>): Promise<{ ok: boolean }> };
    drain(): Promise<void>;
    authority(): { scenarioId: string | null; ownership: string };
    scenario(): Record<string, unknown> & { rangeEnd: string };
    capabilityStamp(): { appBuildVersion: string; manifestSha256: string };
    assistantProposal: {
      prepare(input: Record<string, unknown>): Promise<{ ok: boolean; reason?: string }>;
    };
  };
  __nsAssistant: {
    settings(): Promise<AssistantSettings>;
    ready(): boolean;
    tableCounts(): Promise<Record<string, number>>;
    selectThread(
      scenarioId: string,
    ): Promise<{ threadId: string; globalGeneration: number; scenarioGeneration: number }>;
    appendMessage(input: {
      threadId: string;
      scenarioId: string;
      messageId: string;
      content: string;
      generations?: { globalGeneration: number; scenarioGeneration: number };
    }): Promise<string>;
    clearAll(scenarioId: string | null): Promise<{
      requestId: string;
      operationId: string | null;
      status: "deleted" | "incomplete" | "failed";
      scope: "history" | "all";
      scenarioId: string | null;
      reason: string | null;
      settlement: string | null;
      deletionOutcome: string | null;
    }>;
    activeDiagnostic(): boolean;
    optimizeBases(): Promise<number>;
  };
};

/** Requests the page actually made, so "no provider call" is observed, not assumed. */
function recordRequests(page: Page): string[] {
  const urls: string[] = [];
  page.on("request", (request) => urls.push(request.url()));
  return urls;
}

/** The public catalog, answered locally so no test ever reaches openrouter.ai. */
async function stubCatalog(page: Page) {
  await page.route("**/api/ai/openrouter/models", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "cache-control": "no-store" },
      body: JSON.stringify({
        source: "catalog",
        fallbackVersion: 1,
        models: [{ id: SENTINEL_MODEL, name: "Claude Sonnet 4.5", contextLength: 200_000 }],
        recommendedId: SENTINEL_MODEL,
      }),
    }),
  );
}

/**
 * Answer the credential probe the way OpenRouter would.
 *
 * `null` aborts the request instead, which is the provider-unreachable lane.
 */
async function stubProbe(page: Page, answer: { ok: boolean; code?: string } | null) {
  await page.route("**/api/ai/openrouter/test", (route) =>
    answer === null
      ? route.abort("connectionrefused")
      : route.fulfill({
          status: 200,
          contentType: "application/json",
          headers: { "cache-control": "no-store" },
          body: JSON.stringify(answer),
        }),
  );
}

async function gotoReadyShell(page: Page, path: string) {
  await page.goto(path);
  await page.waitForFunction(() => {
    const ns = (window as unknown as Partial<NsWindow>).__nsStore;
    return Boolean(ns) && ns!.authority().scenarioId !== null;
  });
}

/** Drive the real Settings journey: enable -> key -> model -> Save and test. */
async function enableAndTest(page: Page) {
  await gotoReadyShell(page, "/settings");
  await page.getByTestId("ai-enabled-switch").click();
  await page.getByTestId("ai-key-input").fill(SENTINEL_KEY);
  await page.getByTestId("ai-model-select").selectOption(SENTINEL_MODEL);
  await page.getByTestId("ai-test").click();
}

function settings(page: Page): Promise<AssistantSettings> {
  return page.evaluate(() => (window as unknown as NsWindow).__nsAssistant.settings());
}

test.describe("T11 controlled Phase-1 activation", () => {
  test.beforeEach(async ({ page }, testInfo) => {
    testInfo.setTimeout(60_000);
    await page.addInitScript(() => {
      (window as unknown as { __NS_ENABLE_TEST_BRIDGE?: boolean }).__NS_ENABLE_TEST_BRIDGE = true;
    });
  });

  test("a fresh profile has AI off, with nothing mounted and nothing sent", async ({ page }) => {
    const urls = recordRequests(page);
    await gotoReadyShell(page, "/dates");

    // No entry point anywhere in the shell.
    await expect(page.getByTestId("assistant-launcher")).toHaveCount(0);
    await expect(page.getByTestId("assistant-dock")).toHaveCount(0);
    await expect(page.getByTestId("assistant-sheet")).toHaveCount(0);
    // Not merely hidden: the CopilotKit provider is not mounted at all, so no
    // transport carrying the credential headers exists.
    await expect(page.locator("[data-copilotkit]")).toHaveCount(0);

    // The durable row is the off-by-default contract, and it is genuinely default.
    expect(await settings(page)).toMatchObject({
      enabled: false,
      apiKey: null,
      modelId: null,
      probedAt: null,
    });
    expect(await page.evaluate(() => (window as unknown as NsWindow).__nsAssistant.ready())).toBe(
      false,
    );

    // Nothing reached the runtime or the provider, and no cookie was set.
    expect(urls.filter((url) => url.includes("/api/copilotkit"))).toEqual([]);
    expect(urls.filter((url) => url.includes("openrouter.ai"))).toEqual([]);
    expect(await page.evaluate(() => document.cookie)).toBe("");
  });

  test("Settings is the only discovery surface, and enabling alone is not readiness", async ({
    page,
  }) => {
    await stubCatalog(page);
    await gotoReadyShell(page, "/settings");

    await expect(page.getByTestId("ai-assistant-card")).toBeVisible();
    await expect(page.getByTestId("ai-readiness")).toHaveText("Off");

    await page.getByTestId("ai-enabled-switch").click();

    // Configuring, not Ready: no probe has passed, so still no launcher.
    await expect(page.getByTestId("ai-readiness")).toHaveText("Needs a tested key");
    await expect(page.getByTestId("assistant-launcher")).toHaveCount(0);
    await expect(page.locator("[data-copilotkit]")).toHaveCount(0);
    expect(await settings(page)).toMatchObject({ enabled: true, apiKey: null });
  });

  test("a passed probe is what activates the assistant, and only then", async ({ page }) => {
    await stubCatalog(page);
    await stubProbe(page, { ok: true });
    await enableAndTest(page);

    await expect(page.getByTestId("ai-readiness")).toHaveText("Ready");
    // The credential is masked wherever it is shown.
    await expect(page.getByTestId("ai-key-mask")).toContainText(SENTINEL_KEY.slice(-4));
    await expect(page.getByTestId("ai-key-mask")).not.toContainText(SENTINEL_KEY);

    // The entry point now exists, and opens a mounted panel.
    const launcher = page.getByTestId("assistant-launcher");
    await expect(launcher).toBeVisible();
    await launcher.click();
    await expect(page.getByTestId("assistant-dock")).toBeVisible();
    // `data-copilotkit` marks the app's own scoping wrapper AND elements CopilotKit
    // renders inside it, so the count is not fixed. What matters either way is the
    // binary: zero of them exist before readiness, and the provider is mounted after.
    expect(await page.locator("[data-copilotkit]").count()).toBeGreaterThan(0);

    expect(await settings(page)).toMatchObject({
      enabled: true,
      apiKey: SENTINEL_KEY,
      modelId: SENTINEL_MODEL,
    });
  });

  test("a rejected key stores nothing and activates nothing", async ({ page }) => {
    await stubCatalog(page);
    await stubProbe(page, { ok: false, code: AI_SETUP_CODES.credentialsRejected });
    await enableAndTest(page);

    // The failure names WHAT failed -- the key -- and never quotes an upstream body.
    await expect(page.getByTestId("ai-probe-status")).toContainText(
      "OpenRouter did not accept this key",
    );
    await expect(page.getByTestId("assistant-launcher")).toHaveCount(0);
    expect(await settings(page)).toMatchObject({ apiKey: null, probedAt: null });
  });

  test("an unreachable provider is explained, and leaves scheduling untouched", async ({
    page,
  }) => {
    await stubCatalog(page);
    await stubProbe(page, null);
    await enableAndTest(page);

    await expect(page.getByTestId("ai-probe-status")).toContainText(
      "OpenRouter could not be reached",
    );
    await expect(page.getByTestId("assistant-launcher")).toHaveCount(0);
    expect(await settings(page)).toMatchObject({ apiKey: null });

    // Ordinary editing is completely unaffected by a failed setup.
    const outcome = await page.evaluate(async () => {
      const store = (window as unknown as NsWindow).__nsStore;
      const result = await store.commands.mutate({ rangeEnd: "2026-04-15" });
      await store.drain();
      return { ok: result.ok, rangeEnd: store.scenario().rangeEnd };
    });
    expect(outcome).toEqual({ ok: true, rangeEnd: "2026-04-15" });
  });

  test("the credential lives in exactly one place in the browser", async ({ page }) => {
    await stubCatalog(page);
    await stubProbe(page, { ok: true });
    const urls = recordRequests(page);
    await enableAndTest(page);
    await expect(page.getByTestId("ai-readiness")).toHaveText("Ready");

    const leak = await page.evaluate((key) => {
      const scan = (storage: Storage) =>
        Object.keys(storage).some((name) => (storage.getItem(name) ?? "").includes(key));
      return {
        local: scan(window.localStorage),
        session: scan(window.sessionStorage),
        cookie: document.cookie.includes(key),
        dom: (document.documentElement.textContent ?? "").includes(key),
      };
    }, SENTINEL_KEY);
    expect(leak).toEqual({ local: false, session: false, cookie: false, dom: false });

    // Nor in any URL the page requested. (The probe body legitimately carries it as a
    // header on the same-origin setup route, which is the designed transport.)
    expect(urls.filter((url) => url.includes(SENTINEL_KEY))).toEqual([]);

    // It IS in the one row the flow designates, so this test cannot pass vacuously.
    expect((await settings(page)).apiKey).toBe(SENTINEL_KEY);
  });

  test("Clear all survives a reload, and a late callback cannot recreate the conversation", async ({
    page,
  }) => {
    await stubCatalog(page);
    await stubProbe(page, { ok: true });
    await enableAndTest(page);
    await expect(page.getByTestId("ai-readiness")).toHaveText("Ready");

    // A real conversation, written through the real fenced path, and the generations
    // an in-flight provider callback would be holding.
    const before = await page.evaluate(async () => {
      const ns = window as unknown as NsWindow;
      const scenarioId = ns.__nsStore.authority().scenarioId as string;
      const thread = await ns.__nsAssistant.selectThread(scenarioId);
      const outcome = await ns.__nsAssistant.appendMessage({
        threadId: thread.threadId,
        scenarioId,
        messageId: "msg-before-clear",
        content: "Which nurses are short on Tuesday?",
      });
      return {
        scenarioId,
        thread,
        outcome,
        optimizeBases: await ns.__nsAssistant.optimizeBases(),
      };
    });
    expect(before.outcome).toBe("accepted");

    const clearResult = await page.evaluate(
      (scenarioId) => (window as unknown as NsWindow).__nsAssistant.clearAll(scenarioId),
      before.scenarioId,
    );

    // THE BRIDGE CARRIES THE OPERATION-CORRELATED RESULT DIRECTLY — no store reread.
    // A successful clear reports status "deleted" with a unique requestId.
    expect(clearResult.status).toBe("deleted");
    expect(clearResult.requestId).toBeTruthy();

    // The reload is the point: the fence has to be DURABLE, not a flag in memory.
    await page.reload();
    await page.waitForFunction(() => Boolean((window as unknown as NsWindow).__nsAssistant));

    const after = await page.evaluate(async (captured) => {
      const ns = (window as unknown as NsWindow).__nsAssistant;
      // The late callback: same thread, same message, the generations it captured
      // before the clear.
      const outcome = await ns.appendMessage({
        threadId: captured.thread.threadId,
        scenarioId: captured.scenarioId,
        messageId: "msg-late-callback",
        content: "…and here is the answer you no longer want.",
        generations: {
          globalGeneration: captured.thread.globalGeneration,
          scenarioGeneration: captured.thread.scenarioGeneration,
        },
      });
      return {
        outcome,
        counts: await ns.tableCounts(),
        settings: await ns.settings(),
        activeDiagnostic: ns.activeDiagnostic(),
        optimizeBases: await ns.optimizeBases(),
      };
    }, before);

    // Dropped, and reported as such rather than as a failure to retry.
    expect(after.outcome).toBe("fenced");
    // Nothing was recreated, and the credential is gone with the rest.
    expect(after.counts.assistantMessages).toBe(0);
    expect(after.counts.assistantThreads).toBe(0);
    expect(after.counts.assistantTurns).toBe(0);
    expect(after.counts.assistantSettings).toBe(0);
    // EVERY assistant-owned table the bridge reports, not a chosen few -- proposals,
    // receipts, diagnostic searches and the clear-operation records included. Named
    // individually above where the history matters; asserted wholesale here so a table
    // added later cannot quietly stop being checked.
    expect(
      Object.entries(after.counts).filter(
        ([table, count]) => table !== "assistantGenerations" && count !== 0,
      ),
    ).toEqual([]);
    // The fence rows are the exception, and they must SURVIVE.
    expect(after.counts.assistantGenerations).toBeGreaterThan(0);
    // Durable diagnostic evidence goes with the rest. This is the one Clear all used to
    // leave behind: a completed infeasibility search outliving the conversation that
    // produced it, in a journey that claims to erase every local AI record.
    expect(after.counts.diagnosticSearches).toBe(0);
    // And the card that projected it is gone from this page lifetime too.
    expect(after.activeDiagnostic).toBe(false);
    // ORDINARY OPTIMIZE IS NOT ASSISTANT DATA. Clearing the assistant must not erase a
    // nurse's feasibility evidence.
    expect(after.optimizeBases).toBe(before.optimizeBases);
    expect(after.settings).toMatchObject({ enabled: false, apiKey: null });
    // The fence rows themselves SURVIVE -- that is what makes the drop possible.
    expect(after.counts.assistantGenerations).toBeGreaterThan(0);
    // And the surface is gone with the data.
    await expect(page.getByTestId("assistant-launcher")).toHaveCount(0);
  });

  test("a second tab has no assistant write authority until it takes over", async ({ context }) => {
    const first = await context.newPage();
    await first.addInitScript(() => {
      (window as unknown as { __NS_ENABLE_TEST_BRIDGE?: boolean }).__NS_ENABLE_TEST_BRIDGE = true;
    });
    await gotoReadyShell(first, "/dates");
    await first.waitForFunction(
      () => (window as unknown as NsWindow).__nsStore.authority().ownership === "owner",
    );

    const second = await context.newPage();
    await second.addInitScript(() => {
      (window as unknown as { __NS_ENABLE_TEST_BRIDGE?: boolean }).__NS_ENABLE_TEST_BRIDGE = true;
    });
    await gotoReadyShell(second, "/dates");
    // `read-only` specifically, not merely "not owner": `unknown` is the bring-up
    // state, and settling for it would let the refusal below pass before the second
    // tab had actually contended for the lease.
    await second.waitForFunction(
      () => (window as unknown as NsWindow).__nsStore.authority().ownership === "read-only",
    );

    // The read-only tab cannot prepare a change, so there is nothing for it to Apply.
    const refused = await second.evaluate(async () => {
      const store = (window as unknown as NsWindow).__nsStore;
      return store.assistantProposal.prepare({
        proposalId: crypto.randomUUID(),
        threadId: "e2e-readonly-thread",
        turnId: "e2e-readonly-turn",
        registryStamp: store.capabilityStamp(),
        commands: [
          {
            type: "set_roster_range",
            start: "2026-04-01",
            end: "2026-04-30",
            importPublicHolidays: false,
          },
        ],
        rationale: "Driven by the T11 activation spec.",
        evidence: [],
        outcome: "untested",
      });
    });
    expect(refused.ok).toBe(false);

    // The owner is unaffected -- a read-only tab is not a broken app.
    const owned = await first.evaluate(async () => {
      const store = (window as unknown as NsWindow).__nsStore;
      const result = await store.commands.mutate({ rangeEnd: "2026-05-31" });
      await store.drain();
      return result.ok;
    });
    expect(owned).toBe(true);
  });
});
