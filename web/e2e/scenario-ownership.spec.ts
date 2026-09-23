import { expect, test, type BrowserContext, type Page } from "@playwright/test";

// T03 acceptance — single-writer ownership, proved in a real browser against real
// IndexedDB and real writer leases.
//
// WHY TWO PAGES IN ONE CONTEXT, NOT TWO CONTEXTS. The lease is per SCENARIO in one
// origin's IndexedDB, and the writer identity is the per-tab `sessionStorage` UUID.
// Two Playwright browser contexts get separate storage partitions, so they could
// never contend for the same lease — a "two-context" same-scenario test would pass
// while proving nothing at all. Two pages in ONE context is exactly the product
// situation: one browser, one profile, one database, two tabs, two tab ids.
//
// The unit suite runs the same protocol against fake-indexeddb with an injected
// clock, which is where the boundary arithmetic is pinned. Nothing here claims
// fake-indexeddb concurrency: every assertion below is a real Chromium tab writing
// to a real database, and the expiry test waits out the real 20-second TTL rather
// than simulating it.
//
// The seam is the restricted `window.__nsStore` bridge (`test-bridge.tsx`): the
// typed command bus, the drain, and the read-only authority projection. There is
// no setter to reach for — a spec that could poke the projection directly could
// assert an ownership state the repository never committed.

/** Mirrors `LEASE_TTL_MS` / `LEASE_HEARTBEAT_MS` in `lib/repository/leases.ts`. */
const LEASE_TTL_MS = 20_000;

type CommandOutcome = { ok: boolean; reason?: string; code?: string };

type NsWindow = {
  __nsStore: {
    commands: {
      mutate(patch: Record<string, unknown>): Promise<CommandOutcome>;
      undo(): Promise<CommandOutcome>;
      takeover(): Promise<CommandOutcome>;
      release(): Promise<void>;
      reconcile(): Promise<void>;
    };
    drain(): Promise<void>;
    authority(): {
      scenarioId: string | null;
      documentRevision: number;
      ownership: string;
      heldByTabId: string | null;
      canUndo: boolean;
      canRedo: boolean;
      reloadRequired: boolean;
    };
    scenario(): Record<string, unknown>;
  };
};

/**
 * Open a tab and wait until its authority has finished bring-up. Waiting on
 * `scenarioId` rather than a timeout is what makes the ordering below meaningful:
 * the SECOND tab must not start racing the first one's acquisition.
 */
async function openTab(context: BrowserContext, path = "/"): Promise<Page> {
  const page = await context.newPage();
  await page.addInitScript(() => {
    (window as unknown as { __NS_ENABLE_TEST_BRIDGE?: boolean }).__NS_ENABLE_TEST_BRIDGE = true;
  });
  await page.goto(path);
  await page.waitForFunction(() => {
    const store = (window as unknown as { __nsStore?: NsWindow["__nsStore"] }).__nsStore;
    return Boolean(store) && store!.authority().scenarioId !== null;
  });
  return page;
}

function authority(page: Page) {
  return page.evaluate(() => (window as unknown as NsWindow).__nsStore.authority());
}

function ownership(page: Page) {
  return page.evaluate(() => (window as unknown as NsWindow).__nsStore.authority().ownership);
}

/** This tab's writer identity, read from where the app actually keeps it. */
function tabId(page: Page) {
  return page.evaluate(() => sessionStorage.getItem("nurse-scheduler/tabId"));
}

function rangeStart(page: Page) {
  return page.evaluate(
    () => (window as unknown as NsWindow).__nsStore.scenario().rangeStart as string | undefined,
  );
}

/** Issue one durable command and return its OUTCOME — refusals included. */
function mutate(page: Page, patch: Record<string, unknown>): Promise<CommandOutcome> {
  return page.evaluate((p) => (window as unknown as NsWindow).__nsStore.commands.mutate(p), patch);
}

/** Read the durable envelope straight from IndexedDB, bypassing every projection. */
function readDurableRangeStart(page: Page, scenarioId: string): Promise<string | null> {
  return page.evaluate(async (id) => {
    const open = indexedDB.open("nurse-scheduler");
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    try {
      const record = await new Promise<{ scenario?: { rangeStart?: string } } | undefined>(
        (resolve, reject) => {
          const request = db
            .transaction("scenarioEnvelopes", "readonly")
            .objectStore("scenarioEnvelopes")
            .get(id);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        },
      );
      return record?.scenario?.rangeStart ?? null;
    } finally {
      db.close();
    }
  }, scenarioId);
}

/** Confirm the banner's takeover through the real warned dialog. */
async function takeOverThroughUi(page: Page) {
  await page.getByTestId("ownership-takeover").click();
  const dialog = page.getByTestId("confirm-dialog");
  await expect(dialog).toBeVisible();
  // The warning must state the CONSEQUENCE for the other tab, not just ask.
  await expect(dialog).toContainText(/stop being able to save/i);
  await page.getByTestId("confirm-dialog-confirm").click();
}

test.describe("T03 — single-writer scenario ownership across two real tabs", () => {
  test("a second tab on the same scenario is read-only, and the owner keeps writing", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    try {
      const owner = await openTab(context);
      expect(await ownership(owner)).toBe("owner");
      expect(await mutate(owner, { rangeStart: "2026-06-01" })).toMatchObject({ ok: true });

      const reader = await openTab(context);

      // The second tab selects the SAME scenario — it can read everything — but it
      // never acquired the lease, and it says so rather than silently swallowing
      // edits.
      const readerState = await authority(reader);
      expect(readerState.ownership).toBe("read-only");
      expect(readerState.scenarioId).toBe((await authority(owner)).scenarioId);
      expect(readerState.heldByTabId).toBe(await tabId(owner));
      expect(await rangeStart(reader)).toBe("2026-06-01");
      await expect(reader.getByTestId("ownership-banner")).toHaveAttribute(
        "data-ownership",
        "read-only",
      );
      // Undo is not offered to a tab that cannot write.
      expect(readerState.canUndo).toBe(false);

      // A refused write is refused DURABLY, and reports why.
      expect(await mutate(reader, { rangeStart: "2099-01-01" })).toMatchObject({
        ok: false,
        reason: "not-owner",
      });
      const scenarioId = readerState.scenarioId!;
      expect(await readDurableRangeStart(reader, scenarioId)).toBe("2026-06-01");

      // The owner is unaffected by the second tab's existence.
      expect(await mutate(owner, { rangeStart: "2026-06-08" })).toMatchObject({ ok: true });
      expect(await readDurableRangeStart(owner, scenarioId)).toBe("2026-06-08");
      await expect(owner.getByTestId("ownership-banner")).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test("an explicit warned takeover moves the writer, and the former owner is fenced", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    try {
      const first = await openTab(context);
      await mutate(first, { rangeStart: "2026-06-01" });
      const scenarioId = (await authority(first)).scenarioId!;

      const second = await openTab(context);
      await expect(second.getByTestId("ownership-banner")).toHaveAttribute(
        "data-ownership",
        "read-only",
      );

      await takeOverThroughUi(second);
      await expect.poll(() => ownership(second)).toBe("owner");
      await expect(second.getByTestId("ownership-banner")).toHaveCount(0);

      // The former owner learns it was superseded — named as a takeover, not as an
      // expiry, because those need different words.
      await expect.poll(() => ownership(first)).toBe("taken-over");
      await expect(first.getByTestId("ownership-banner")).toHaveAttribute(
        "data-ownership",
        "taken-over",
      );
      expect((await authority(first)).heldByTabId).toBe(await tabId(second));

      // STALE FORMER OWNER. Its next write presents a lease epoch the durable row
      // has moved past, so the transaction refuses it — the fence is the persisted
      // row, not the cross-tab notification that happened to arrive first.
      expect(await mutate(first, { rangeStart: "2099-01-01" })).toMatchObject({
        ok: false,
        reason: "not-owner",
      });
      expect(await readDurableRangeStart(first, scenarioId)).toBe("2026-06-01");
      // Nor can it reverse the new owner's history.
      expect(
        await first.evaluate(() => (window as unknown as NsWindow).__nsStore.commands.undo()),
      ).toMatchObject({ ok: false });

      // The new owner writes normally.
      expect(await mutate(second, { rangeStart: "2026-07-01" })).toMatchObject({ ok: true });
      expect(await readDurableRangeStart(second, scenarioId)).toBe("2026-07-01");
    } finally {
      await context.close();
    }
  });

  test("a crashed owner's lease expires, and a fresh tab recovers the saved schedule", async ({
    browser,
  }) => {
    // Waits out the REAL 20-second TTL. Nothing here fakes a clock: the claim is
    // that a lease whose holder stopped heart-beating actually lapses in a browser.
    test.setTimeout(120_000);
    const context = await browser.newContext();
    try {
      const crashing = await openTab(context);
      await mutate(crashing, { rangeStart: "2026-06-01" });
      const scenarioId = (await authority(crashing)).scenarioId!;

      // Before the crash, a second tab is correctly locked out — which is what
      // makes the recovery below a real state change rather than a tab that was
      // never blocked.
      const blocked = await openTab(context);
      expect(await ownership(blocked)).toBe("read-only");
      await blocked.close();

      // A CRASH, not a close: killing the renderer skips `pagehide`, so the lease is
      // never released and only expiry can reclaim it. `page.close()` would take the
      // clean-release path and prove the wrong thing.
      const session = await context.newCDPSession(crashing);
      const crashed = crashing.waitForEvent("crash");
      // Not awaited: `Page.crash` kills the target, so the CDP call never gets a
      // reply. The page's own `crash` event is the signal that it is really gone.
      void session.send("Page.crash").catch(() => {});
      await crashed;

      await new Promise((resolve) => setTimeout(resolve, LEASE_TTL_MS + 2_000));

      // A tab opened after the lease lapsed acquires it during ordinary bring-up:
      // no takeover prompt, because there is no live owner to warn about.
      const recovered = await openTab(context);
      expect(await ownership(recovered)).toBe("owner");
      await expect(recovered.getByTestId("ownership-banner")).toHaveCount(0);
      // And it recovers the crashed tab's COMMITTED work, on the same identity.
      expect((await authority(recovered)).scenarioId).toBe(scenarioId);
      expect(await rangeStart(recovered)).toBe("2026-06-01");
      expect(await mutate(recovered, { rangeStart: "2026-06-15" })).toMatchObject({ ok: true });
    } finally {
      await context.close();
    }
  });

  test("a real back navigation reaches durable truth on BOTH resumption paths", async ({
    browser,
  }) => {
    // A real navigation journey, not a synthetic event.
    //
    // An earlier version dispatched `pageshow` by hand, which proved the listener was
    // wired and nothing else: no navigation, no suspension, no heartbeat interruption.
    // This navigates AWAY (a cross-document navigation, which is what makes a page
    // eligible for the back/forward cache at all), lets a peer take the lease and
    // change the document while this page is away, then navigates BACK.
    //
    // The contract under test is that the tab ends at durable truth WHICHEVER way the
    // browser serves that back navigation — a granted BFCache restoration or a full
    // reinitialization. Both are asserted below, and the test never requires Chromium
    // to choose one.
    const context = await browser.newContext();
    try {
      const resuming = await openTab(context);
      await mutate(resuming, { rangeStart: "2026-06-01" });
      const scenarioId = (await authority(resuming)).scenarioId!;

      // Record every `pageshow` from before the navigation, so the restore is
      // observable rather than inferred.
      await resuming.evaluate(() => {
        const w = window as unknown as { __nsPageShow?: boolean[] };
        w.__nsPageShow = [];
        window.addEventListener("pageshow", (event) => {
          w.__nsPageShow!.push((event as PageTransitionEvent).persisted);
        });
      });

      // Navigate AWAY within the same origin (a cross-document navigation).
      await resuming.goto("/people");
      await expect(resuming.getByTestId("screen")).toBeVisible();

      // While it is away, a peer seizes the lease and changes the document.
      const peer = await openTab(context);
      await takeOverThroughUi(peer);
      await expect.poll(() => ownership(peer)).toBe("owner");
      expect(await mutate(peer, { rangeStart: "2026-08-01" })).toMatchObject({ ok: true });

      // ...and back. This is the resumption the app's `pageshow` listener exists for.
      await resuming.goBack();
      await resuming.waitForFunction(() => {
        const store = (window as unknown as { __nsStore?: NsWindow["__nsStore"] }).__nsStore;
        return Boolean(store) && store!.authority().scenarioId !== null;
      });

      const restoredFromBFCache = await resuming.evaluate(
        () =>
          ((window as unknown as { __nsPageShow?: boolean[] }).__nsPageShow ?? []).at(-1) === true,
      );
      // Chromium reports WHY a back navigation was not served from BFCache. Reading it
      // turns "the restore did not happen" from an unexplained shrug into evidence.
      const blockedBy = await resuming.evaluate(() => {
        const entry = performance.getEntriesByType("navigation")[0] as
          | (PerformanceNavigationTiming & {
              notRestoredReasons?: { reasons?: { reason: string }[] } | null;
            })
          | undefined;
        return entry?.notRestoredReasons?.reasons?.map((reason) => reason.reason) ?? [];
      });

      // Chromium may serve the back navigation EITHER way, and the app is required to
      // be correct on both. Classify the path explicitly so a third, unrecognised
      // behaviour fails here instead of passing quietly:
      //
      //   • RESTORED    — the document came back from the back/forward cache. Process
      //                   memory survived, so the `pageshow` listener's authoritative
      //                   reread is what corrects this tab's view and ownership.
      //   • REINITIALIZED — the document was re-created. Bring-up runs again and reads
      //                   durable truth from scratch.
      //
      // Which one runs is the browser's business, and this test does not require
      // either. Eligibility is genuinely uncertain for this app: it holds an IndexedDB
      // connection and a BroadcastChannel open for each page's lifetime, and both are
      // documented Chromium BFCache blockers — so the reinitialization path is the one
      // usually observed here, while the persisted-pageshow path stays correct and
      // defensive for the engines and conditions that do restore.
      const path = restoredFromBFCache ? "restored" : "reinitialized";
      expect(["restored", "reinitialized"]).toContain(path);

      if (path === "restored") {
        // The listener really fired with `persisted: true` — that is what makes the
        // reread, rather than a fresh bring-up, responsible for the state below.
        const persistedEvents = await resuming.evaluate(
          () => (window as unknown as { __nsPageShow?: boolean[] }).__nsPageShow ?? [],
        );
        expect(persistedEvents).toContain(true);
      } else {
        // A re-created document has no pre-navigation listener state left, which is the
        // observable signature of the fallback.
        const survived = await resuming.evaluate(
          () => (window as unknown as { __nsPageShow?: boolean[] }).__nsPageShow !== undefined,
        );
        expect(survived).toBe(false);
      }

      // AND ON EITHER PATH the tab ends at durable truth: it shows the peer's
      // committed content, it is not the writer, and its write is refused.
      await expect.poll(() => rangeStart(resuming)).toBe("2026-08-01");
      expect(await ownership(resuming)).not.toBe("owner");
      expect(await mutate(resuming, { rangeStart: "2099-01-01" })).toMatchObject({ ok: false });
      expect(await readDurableRangeStart(resuming, scenarioId)).toBe("2026-08-01");
      // The peer still owns it — the resuming tab did not silently re-acquire.
      expect(await ownership(peer)).toBe("owner");

      // Record which path ran, so a change in eligibility is visible rather than
      // silent. Not an assertion: the app must not depend on the browser's choice.
      // eslint-disable-next-line no-console
      console.log(
        `[scenario-ownership] back navigation served as: ${path}${
          blockedBy.length > 0 ? ` — BFCache blocked by: ${blockedBy.join(", ")}` : ""
        }`,
      );

      // Taking editing back from the resumed page works.
      await takeOverThroughUi(resuming);
      await expect.poll(() => ownership(resuming)).toBe("owner");
      expect(await mutate(resuming, { rangeStart: "2026-09-01" })).toMatchObject({ ok: true });
    } finally {
      await context.close();
    }
  });

  test("a DUPLICATED tab does not share its opener's writer identity", async ({ browser }) => {
    // `sessionStorage` is COPIED into a tab created by `window.open`/duplication. Two
    // controllers then presented ONE tab id, so acquisition renewed the lease in
    // place rather than refusing, cross-tab hints were self-filtered, and neither tab
    // ever went read-only — two live writers on one scenario under one epoch.
    const context = await browser.newContext();
    try {
      const original = await openTab(context);
      await mutate(original, { rangeStart: "2026-06-01" });
      const originalTab = await tabId(original);
      const scenarioId = (await authority(original)).scenarioId!;

      // Duplicate it the way a browser does: a new page that STARTS with a copy of
      // the opener's sessionStorage.
      const duplicate = await context.newPage();
      await duplicate.addInitScript(
        ([copiedTabId]) => {
          (window as unknown as { __NS_ENABLE_TEST_BRIDGE?: boolean }).__NS_ENABLE_TEST_BRIDGE =
            true;
          sessionStorage.setItem("nurse-scheduler/tabId", copiedTabId as string);
        },
        [originalTab] as const,
      );
      await duplicate.goto("/");
      await duplicate.waitForFunction(() => {
        const store = (window as unknown as { __nsStore?: NsWindow["__nsStore"] }).__nsStore;
        return Boolean(store) && store!.authority().scenarioId !== null;
      });

      // The duplicate re-minted its identity, so it is a genuinely second tab...
      expect(await tabId(duplicate)).not.toBe(originalTab);
      // ...and is therefore correctly read-only against the live owner.
      expect(await ownership(duplicate)).toBe("read-only");
      expect((await authority(duplicate)).heldByTabId).toBe(originalTab);
      expect(await mutate(duplicate, { rangeStart: "2099-01-01" })).toMatchObject({
        ok: false,
        reason: "not-owner",
      });
      expect(await readDurableRangeStart(duplicate, scenarioId)).toBe("2026-06-01");

      // The original is untouched and still writing.
      expect(await ownership(original)).toBe("owner");
      expect(await mutate(original, { rangeStart: "2026-06-08" })).toMatchObject({ ok: true });
    } finally {
      await context.close();
    }
  });

  test("a synthetic resumption signal still reconciles (listener wiring)", async ({ browser }) => {
    const context = await browser.newContext();
    try {
      const first = await openTab(context);
      await mutate(first, { rangeStart: "2026-06-01" });
      const scenarioId = (await authority(first)).scenarioId!;

      const second = await openTab(context);
      await takeOverThroughUi(second);
      await expect.poll(() => ownership(first)).toBe("taken-over");

      // The new owner edits and then RELEASES cleanly, so the lease is free.
      await mutate(second, { rangeStart: "2026-08-01" });
      await second.evaluate(() => (window as unknown as NsWindow).__nsStore.commands.release());

      // The former owner comes back from BFCache. `pageshow` with `persisted: true`
      // is the real resumption signal the app listens for.
      await first.evaluate(() => {
        window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
      });

      // Two claims, and the second is the load-bearing one:
      //   • the reread agrees with durable truth — the tab shows the content it
      //     never performed;
      //   • it does NOT silently re-acquire the free lease. A tab that resumed after
      //     being superseded must not become the writer again without anyone asking,
      //     so it stays read-only and offers the explicit action instead.
      await expect.poll(() => rangeStart(first)).toBe("2026-08-01");
      expect(["read-only", "taken-over"]).toContain(await ownership(first));
      expect(await mutate(first, { rangeStart: "2099-01-01" })).toMatchObject({ ok: false });
      expect(await readDurableRangeStart(first, scenarioId)).toBe("2026-08-01");

      // A visibility restore is the same authoritative reread, and taking the lease
      // back through the banner works from there.
      await first.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      await takeOverThroughUi(first);
      await expect.poll(() => ownership(first)).toBe("owner");
      expect(await mutate(first, { rangeStart: "2026-09-01" })).toMatchObject({ ok: true });
    } finally {
      await context.close();
    }
  });

  test("two tabs editing DIFFERENT scenarios both write, with no contention", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    try {
      const first = await openTab(context);
      await mutate(first, { rangeStart: "2026-06-01" });
      const firstScenario = (await authority(first)).scenarioId!;

      // The second tab starts read-only on the same scenario, then LOADS a workspace
      // file — the product's own scenario switch, which mints a fresh identity. It is
      // driven through the real Save & Load UI rather than a bridge shortcut, because
      // "a read-only tab can still start its own document" is a UI claim too.
      const second = await openTab(context, "/save-and-load");
      expect(await ownership(second)).toBe("read-only");

      await second.getByTestId("scenario-upload-button").click();
      await expect(second.getByTestId("upload-modal")).toBeVisible();
      await second.getByTestId("upload-file-input").setInputFiles({
        name: "other.yaml",
        mimeType: "text/yaml",
        buffer: Buffer.from(OTHER_WORKSPACE_YAML),
      });
      // A load into an empty-or-not workspace with no app version gates on the
      // version confirmation first.
      await second.getByTestId("confirm-dialog-confirm").click();

      await expect.poll(() => ownership(second)).toBe("owner");
      const secondScenario = (await authority(second)).scenarioId!;
      expect(secondScenario).not.toBe(firstScenario);

      // Neither tab disturbed the other: the first still owns its own scenario and
      // shows no banner, and both commit concurrently.
      expect(await ownership(first)).toBe("owner");
      await expect(first.getByTestId("ownership-banner")).toHaveCount(0);
      await expect(second.getByTestId("ownership-banner")).toHaveCount(0);

      const [firstOutcome, secondOutcome] = await Promise.all([
        mutate(first, { rangeStart: "2026-06-08" }),
        mutate(second, { rangeStart: "2027-01-04" }),
      ]);
      expect(firstOutcome).toMatchObject({ ok: true });
      expect(secondOutcome).toMatchObject({ ok: true });

      // Each write landed on its OWN envelope.
      expect(await readDurableRangeStart(first, firstScenario)).toBe("2026-06-08");
      expect(await readDurableRangeStart(first, secondScenario)).toBe("2027-01-04");
    } finally {
      await context.close();
    }
  });
});

/** A valid Workspace document, deliberately without `appVersion`. */
const OTHER_WORKSPACE_YAML = `apiVersion: alpha
dates:
  range:
    startDate: 2026-12-01
    endDate: 2026-12-07
people:
  items:
    - id: Cara
shiftTypes:
  items:
    - id: N
      description: Night
preferences:
  - type: shift type requirement
    shiftType: N
    requiredNumPeople: 1
    qualifiedPeople: ALL
    date: ALL
`;
