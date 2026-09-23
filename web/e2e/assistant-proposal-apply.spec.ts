import { expect, test, type Page } from "@playwright/test";

// T07 acceptance in a REAL browser: prepare -> confirm -> Apply -> receipt -> Undo,
// driven against a production build through the same `window.__nsStore` seam the
// other acceptance specs use.
//
// WHAT THIS LAYER ADDS over the unit and component suites. Those run against
// `fake-indexeddb` and a React test renderer; they can prove the logic and the card.
// They cannot prove that the Apply transaction is genuinely atomic in Chromium's
// IndexedDB, that the cascade really destroys the references it says it will, or
// that the applied change actually reaches the screens the receipt names. This spec
// asserts all three against the shipped app.
//
// WHY THE HOST SEAM RATHER THAN A CHAT TURN. Apply is a HOST action by design -- the
// model's only part is naming an operation, and no provider call is needed to reach
// the boundary under test. Driving it through the command surface exercises the
// exact path the panel's Apply button calls, without making a browser acceptance
// test depend on a live OpenRouter model. The Preview card's own rendering, its
// confirmation gating and its stale states are covered by
// `components/ai/assistant-proposal.test.tsx`.

type AssistantCommand =
  | { type: "set_roster_range"; start: string; end: string; importPublicHolidays: boolean }
  | { type: "move_leave"; personId: string; fromDate: string; toDate: string };

type ProposalRow = {
  proposalId: string;
  revision: number;
  status: string;
  assumptions: { assumptionId: string; question: string }[];
  diff: {
    direct: { key: string; before: string | null; after: string | null }[];
    cascade: { key: string; before: string | null; after: string | null }[];
    capabilityIds: string[];
    needsReview: string[];
  };
};

type PrepareOutcome =
  | { ok: true; proposal: ProposalRow }
  | { ok: false; reason: string; rejection?: { code: string; message: string } };

type ApplyOutcome =
  | { ok: true; receipt: { receiptId: string }; replayed: boolean; commitId: string }
  | { ok: false; reason: string };

type NsWindow = {
  __nsStore: {
    commands: { mutate(patch: Record<string, unknown>): Promise<{ ok: boolean }> };
    drain(): Promise<void>;
    historyDepth(): Promise<number>;
    authority(): { scenarioId: string | null; documentRevision: number; ownership: string };
    scenario(): Record<string, unknown> & { reqData: { uid?: string }[]; rangeEnd: string };
    capabilityStamp(): { appBuildVersion: string; manifestSha256: string };
    assistantProposal: {
      prepare(input: Record<string, unknown>): Promise<PrepareOutcome>;
      confirm(input: { proposalId: string; assumptionId: string }): Promise<PrepareOutcome>;
      apply(input: { proposalId: string; receiptId: string }): Promise<ApplyOutcome>;
      undoReceipt(receiptId: string): Promise<{ ok: boolean }>;
      describeReceipts(): Promise<{ receipt: { receiptId: string }; undo: string }[]>;
      read(proposalId: string): Promise<ProposalRow | null>;
    };
  };
};

// A same-month range, so date-item ids are the bare `DD` form.
const BASE_SEED = {
  rangeStart: "2026-04-01",
  rangeEnd: "2026-04-30",
  staff: [
    { id: "Ana", history: [] },
    { id: "Bo", history: [] },
  ],
  shifts: [{ id: "AM" }, { id: "PM" }],
  reqData: [
    { uid: "cell-leave", person: "Ana", date: "02", kind: "leave" },
    { uid: "cell-off", person: "Bo", date: "29", kind: "off", weight: -5 },
  ],
};

async function gotoReady(page: Page) {
  await page.goto("/dates");
  await page.waitForFunction(() => {
    const store = (window as unknown as NsWindow).__nsStore;
    return Boolean(store) && store.authority().scenarioId !== null;
  });
  await expect(page.getByRole("heading", { name: "Schedule Dates" })).toBeVisible();
}

async function seed(page: Page) {
  await page.evaluate(async (patch) => {
    const store = (window as unknown as NsWindow).__nsStore;
    await store.commands.mutate(patch);
    await store.drain();
  }, BASE_SEED);
}

async function prepare(page: Page, commands: AssistantCommand[]): Promise<PrepareOutcome> {
  return page.evaluate(async (ops) => {
    const store = (window as unknown as NsWindow).__nsStore;
    return store.assistantProposal.prepare({
      proposalId: crypto.randomUUID(),
      threadId: "e2e-thread",
      turnId: "e2e-turn",
      registryStamp: store.capabilityStamp(),
      commands: ops,
      rationale: "Driven by the T07 acceptance spec.",
      evidence: [],
      outcome: "untested",
    });
  }, commands);
}

test.describe("T07 assistant Preview, confirmation and Apply", () => {
  test.beforeEach(async ({ page }, testInfo) => {
    testInfo.setTimeout(45_000);
    await page.addInitScript(() => {
      (window as unknown as { __NS_ENABLE_TEST_BRIDGE?: boolean }).__NS_ENABLE_TEST_BRIDGE = true;
    });
  });

  test("a prepared change alters nothing until Apply, then lands as one undoable commit", async ({
    page,
  }) => {
    await gotoReady(page);
    await seed(page);

    const depthBefore = await page.evaluate(() =>
      (window as unknown as NsWindow).__nsStore.historyDepth(),
    );

    const prepared = await prepare(page, [
      {
        type: "set_roster_range",
        start: "2026-04-01",
        end: "2026-04-15",
        importPublicHolidays: false,
      },
    ]);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    // The HOST worked out the knock-on effect: Bo's preference on the 29th is
    // destroyed by the shrink, and the later setup domain is marked for review.
    expect(prepared.proposal.diff.direct.map((entry) => entry.key)).toEqual(["dates:range"]);
    expect(prepared.proposal.diff.cascade.some((entry) => entry.after === null)).toBe(true);
    expect(prepared.proposal.diff.needsReview).toContain("requests");
    expect(prepared.proposal.diff.capabilityIds).toContain("roster-period");

    // PREPARING IS NOT APPLYING. The screen and the document are untouched.
    await expect(page.getByTestId("range-duration")).toContainText("30 days");
    expect(
      await page.evaluate(() => (window as unknown as NsWindow).__nsStore.scenario().rangeEnd),
    ).toBe("2026-04-30");

    const applied = await page.evaluate(async (proposalId) => {
      const store = (window as unknown as NsWindow).__nsStore;
      const result = await store.assistantProposal.apply({
        proposalId,
        receiptId: crypto.randomUUID(),
      });
      await store.drain();
      return result;
    }, prepared.proposal.proposalId);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;

    // The real screen re-rendered from the committed projection, and the real
    // cascade really removed the out-of-range preference.
    await expect(page.getByTestId("range-duration")).toContainText("15 days");
    const after = await page.evaluate(() => (window as unknown as NsWindow).__nsStore.scenario());
    expect(after.rangeEnd).toBe("2026-04-15");
    expect(after.reqData.some((cell) => cell.uid === "cell-off")).toBe(false);

    // Exactly ONE temporal entry for the whole change, cascade included.
    const depthAfter = await page.evaluate(() =>
      (window as unknown as NsWindow).__nsStore.historyDepth(),
    );
    expect(depthAfter - depthBefore).toBe(1);

    // A receipt that can currently be undone, and an Undo that really reverses it.
    const receipts = await page.evaluate(() =>
      (window as unknown as NsWindow).__nsStore.assistantProposal.describeReceipts(),
    );
    expect(receipts).toHaveLength(1);
    expect(receipts[0].undo).toBe("available");

    await page.evaluate(async (receiptId) => {
      const store = (window as unknown as NsWindow).__nsStore;
      await store.assistantProposal.undoReceipt(receiptId);
      await store.drain();
    }, receipts[0].receipt.receiptId);

    await expect(page.getByTestId("range-duration")).toContainText("30 days");
    const restored = await page.evaluate(() =>
      (window as unknown as NsWindow).__nsStore.scenario(),
    );
    expect(restored.reqData.some((cell) => cell.uid === "cell-off")).toBe(true);

    // The receipt is KEPT and truthfully no longer undoable.
    const settled = await page.evaluate(() =>
      (window as unknown as NsWindow).__nsStore.assistantProposal.describeReceipts(),
    );
    expect(settled).toHaveLength(1);
    expect(settled[0].undo).not.toBe("available");
  });

  test("Apply refuses without the operational confirmation, and lands with it", async ({
    page,
  }) => {
    await gotoReady(page);
    await seed(page);

    const prepared = await prepare(page, [
      { type: "move_leave", personId: "Ana", fromDate: "02", toDate: "10" },
    ]);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    // The host derived the question from the validated target, naming the person
    // and both dates. No model prose is involved.
    expect(prepared.proposal.status).toBe("confirmation_required");
    expect(prepared.proposal.assumptions).toHaveLength(1);
    expect(prepared.proposal.assumptions[0].question).toContain("Ana");

    const proposalId = prepared.proposal.proposalId;
    const refused = await page.evaluate(async (id) => {
      const store = (window as unknown as NsWindow).__nsStore;
      const result = await store.assistantProposal.apply({
        proposalId: id,
        receiptId: crypto.randomUUID(),
      });
      await store.drain();
      return result;
    }, proposalId);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toBe("confirmation-missing");
    // Nothing moved.
    expect(
      await page.evaluate(() =>
        (window as unknown as NsWindow).__nsStore
          .scenario()
          .reqData.some((cell) => (cell as { date?: string }).date === "10"),
      ),
    ).toBe(false);

    const applied = await page.evaluate(
      async ({ id, assumptionId }) => {
        const store = (window as unknown as NsWindow).__nsStore;
        await store.assistantProposal.confirm({ proposalId: id, assumptionId });
        const result = await store.assistantProposal.apply({
          proposalId: id,
          receiptId: crypto.randomUUID(),
        });
        await store.drain();
        return result;
      },
      { id: proposalId, assumptionId: prepared.proposal.assumptions[0].assumptionId },
    );
    expect(applied.ok).toBe(true);

    const reqData = await page.evaluate(
      () => (window as unknown as NsWindow).__nsStore.scenario().reqData,
    );
    expect(reqData).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ uid: "cell-leave", date: "10", kind: "leave" }),
      ]),
    );
  });

  test("a change that lands after the Preview makes it Out of date, and Apply refuses", async ({
    page,
  }) => {
    await gotoReady(page);
    await seed(page);

    const prepared = await prepare(page, [
      {
        type: "set_roster_range",
        start: "2026-04-01",
        end: "2026-04-15",
        importPublicHolidays: false,
      },
    ]);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    // An ordinary manual edit between Preview and Apply.
    await page.evaluate(async () => {
      const store = (window as unknown as NsWindow).__nsStore;
      await store.commands.mutate({ meta: { apiVersion: "alpha", description: "edited" } });
      await store.drain();
    });

    const result = await page.evaluate(async (proposalId) => {
      const store = (window as unknown as NsWindow).__nsStore;
      const applied = await store.assistantProposal.apply({
        proposalId,
        receiptId: crypto.randomUUID(),
      });
      await store.drain();
      return applied;
    }, prepared.proposal.proposalId);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("stale");
    // The pre-Apply state is intact: a refused Apply changes nothing at all.
    await expect(page.getByTestId("range-duration")).toContainText("30 days");
    expect(
      await page.evaluate(() =>
        (window as unknown as NsWindow).__nsStore.assistantProposal.describeReceipts(),
      ),
    ).toHaveLength(0);
  });

  test("an unsupported operation is refused with the host's own explanation", async ({ page }) => {
    await gotoReady(page);
    await seed(page);

    // There is no leave on the 11th, so there is nothing to move. The host says so;
    // it does not approximate something nearby.
    const outcome = await prepare(page, [
      { type: "move_leave", personId: "Ana", fromDate: "11", toDate: "12" },
    ]);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe("rejected");
      expect(outcome.rejection?.code).toBe("unknown_target");
    }
    expect(
      await page.evaluate(() =>
        (window as unknown as NsWindow).__nsStore.assistantProposal.describeReceipts(),
      ),
    ).toHaveLength(0);
  });
});
