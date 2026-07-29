import { expect, test, type Locator, type Page } from "@playwright/test";

// F3 — the real-browser half of the overlay contract. The eight owners now share
// one Dialog / AlertDialog shell, and the things a shared shell can silently
// break are exactly the things jsdom cannot see: where the popup actually lands
// in the document, what the scrim computes to per theme, whether the drawer is
// really 250px against the left edge with the page scroll locked, whether the
// reserved higher layer really covers the live page, and whether focus comes
// back to the control that opened the overlay.
//
// On layering, this file states only what the CURRENT product actually reaches.
// The shell publishes two named layers, and Clear Confirm is the sole owner of
// the reserved `nested` / z-60 one; but no shipped route mounts a `base` (z-50)
// overlay and Clear Confirm at the same time — the Requests roots are sibling
// conditional flows, and Save/Load's upload modal unmounts as its version gate
// opens. So the assertions below prove the reserved layer against the live
// page, and deliberately do NOT claim concurrent two-overlay hit-testing or
// cross-layer focus containment. If a real flow ever mounts both at once, that
// coverage is what should be added here — not a harness route invented to
// manufacture the collision.
//
// Behavioural rules (exactly-once callbacks, draft discard, parse ownership) are
// pinned by the eight focused component suites; this file deliberately does not
// restate them, and asserts only what needs a browser.

const SCRIM_LIGHT = "rgba(17, 24, 22, 0.52)";
const SCRIM_DARK = "rgba(17, 24, 22, 0.72)";

/** The v2 card radius, as Chromium renders `--r-card`. */
const CARD_RADIUS = "16px";

type NsWindow = {
  __nsStore: {
    scenario: {
      getState(): Record<string, unknown> & { mutateScenario(patch: unknown): void };
    };
  };
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __NS_ENABLE_TEST_BRIDGE?: boolean }).__NS_ENABLE_TEST_BRIDGE = true;
  });
});

async function gotoReady(page: Page, path: string) {
  await page.goto(path);
  await expect(page.getByTestId("screen")).toBeVisible();
  await page.waitForFunction(() =>
    Boolean((window as unknown as { __nsStore?: unknown }).__nsStore),
  );
}

function seed(page: Page, patch: Record<string, unknown>) {
  return page.evaluate((p) => {
    (window as unknown as NsWindow).__nsStore.scenario.getState().mutateScenario(p);
  }, patch);
}

function style(locator: Locator, property: string): Promise<string> {
  return locator.evaluate(
    (element, prop) => getComputedStyle(element).getPropertyValue(prop),
    property,
  );
}

/** The single scrim rendered for the currently open overlay. */
function scrim(page: Page): Locator {
  return page.locator("[data-slot='dialog-overlay'], [data-slot='alert-dialog-overlay']").last();
}

/** True when the popup is portaled out of the routed screen and onto <body>. */
function isPortaled(popup: Locator): Promise<boolean> {
  return popup.evaluate((element) => {
    const portal = element.closest("[data-slot$='dialog-portal']");
    return (
      portal !== null &&
      element.closest("[data-testid='screen']") === null &&
      element.closest("main") === null &&
      document.body.contains(element)
    );
  });
}

/** The element actually painted at a point — the honest z-order question. */
function topmostAt(page: Page, x: number, y: number): Promise<string | null> {
  return page.evaluate(
    ([px, py]) => {
      const element = document.elementFromPoint(px, py);
      return element?.closest("[data-testid]")?.getAttribute("data-testid") ?? null;
    },
    [x, y] as const,
  );
}

const REQUESTS_SEED = {
  rangeStart: "2026-01-01",
  rangeEnd: "2026-01-05",
  staff: [{ id: "Aisha", history: [] }],
  shifts: [{ id: "AM" }],
};

// Aisha carries REAL history, so `historyColumnCount` is 3 and slot index 1
// resolves to a populated, actionable H-2 — an inert padding slot would make the
// history-editor flow below vacuous.
const REQUESTS_HISTORY_SEED = {
  rangeStart: "2026-01-01",
  rangeEnd: "2026-01-05",
  staff: [{ id: "Aisha", history: ["PM", "AM"] }],
  shifts: [{ id: "AM" }, { id: "PM" }],
};

// A valid scenario with NO appVersion — drives the Save/Load version-confirm
// gate, where the upload modal unmounts before the confirmation appears: a
// sequential handover between two base-layer overlays, not a stack.
const YAML_WITHOUT_VERSION = `apiVersion: alpha
dates:
  range:
    startDate: 2026-06-01
    endDate: 2026-06-07
people:
  items:
    - id: Alice
shiftTypes:
  items:
    - id: D
      description: Day
      startTime: "09:00"
      endTime: "17:00"
      durationMinutes: 480
preferences:
  - type: shift type requirement
    shiftType: D
    requiredNumPeople: 1
    qualifiedPeople: ALL
    date: ALL
`;

test.describe("shared overlay shell — portal, scrim and raised surface", () => {
  test("a centred overlay portals out of the screen onto the canonical scrim", async ({ page }) => {
    await gotoReady(page, "/people");
    await page.getByTestId("people-upload").click();

    const popup = page.getByTestId("upload-dialog");
    await expect(popup).toBeVisible();
    expect(await isPortaled(popup)).toBe(true);

    await expect.poll(() => style(scrim(page), "background-color")).toBe(SCRIM_LIGHT);
    expect(await style(popup, "border-radius")).toBe(CARD_RADIUS);
    expect(await style(popup, "box-shadow")).not.toBe("none");
    // L2 tone, not the L1 card tone and never a pure black/white plane.
    expect(await style(popup, "background-color")).not.toBe("rgb(0, 0, 0)");
  });

  test("the scrim follows the theme rather than a fixed near-black RGBA", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("ns-theme", "dark"));
    await gotoReady(page, "/people");
    await page.getByTestId("people-upload").click();
    await expect(page.getByTestId("upload-dialog")).toBeVisible();

    await expect.poll(() => style(scrim(page), "background-color")).toBe(SCRIM_DARK);
    expect(await style(page.getByTestId("upload-dialog"), "border-radius")).toBe(CARD_RADIUS);
  });
});

test.describe("People upload — the one Escape exception", () => {
  test("Escape is ignored, while the close button closes and restores focus", async ({ page }) => {
    await gotoReady(page, "/people");
    const trigger = page.getByTestId("people-upload");
    await trigger.click();
    await expect(page.getByTestId("upload-dialog")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.getByTestId("upload-dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("upload-dialog")).toBeVisible();

    await page.getByTestId("upload-dialog-close").click();
    await expect(page.getByTestId("upload-dialog")).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test("a backdrop press still closes it — the exception is Escape alone", async ({ page }) => {
    await gotoReady(page, "/people");
    await page.getByTestId("people-upload").click();
    await expect(page.getByTestId("upload-dialog")).toBeVisible();

    await scrim(page).click({ position: { x: 5, y: 5 } });
    await expect(page.getByTestId("upload-dialog")).toHaveCount(0);
  });
});

test.describe("Mobile navigation drawer — side geometry and modal behaviour", () => {
  test.use({ viewport: { width: 520, height: 800 } });

  test("is a left-anchored 250px drawer with the directional shadow and a locked page", async ({
    page,
  }) => {
    await gotoReady(page, "/people");
    await page.getByTestId("mobile-nav-trigger").click();

    const drawer = page.getByTestId("mobile-nav-drawer");
    await expect(drawer).toBeVisible();
    expect(await isPortaled(drawer)).toBe(true);

    // The drawer slides in from -100%; poll until the transition settles rather
    // than measuring mid-flight.
    await expect.poll(async () => Math.round((await drawer.boundingBox())!.x)).toBe(0);
    const box = (await drawer.boundingBox())!;
    expect(Math.round(box.width)).toBe(250);
    expect(Math.round(box.height)).toBe(800);

    // Square by contract, and the specialized side cast — not the dialog shadow.
    expect(await style(drawer, "border-radius")).toBe("0px");
    expect(await style(drawer, "box-shadow")).toContain("-16px");
    await expect.poll(() => style(scrim(page), "background-color")).toBe(SCRIM_LIGHT);

    // Modal scroll lock: the document cannot scroll behind the drawer.
    const locked = await page.evaluate(
      () =>
        getComputedStyle(document.documentElement).overflow === "hidden" ||
        getComputedStyle(document.body).overflow === "hidden",
    );
    expect(locked).toBe(true);
  });

  test("keyboard focus stays inside the drawer and returns to the trigger on Escape", async ({
    page,
  }) => {
    await gotoReady(page, "/people");
    const trigger = page.getByTestId("mobile-nav-trigger");
    await trigger.click();
    const drawer = page.getByTestId("mobile-nav-drawer");
    await expect(drawer).toBeVisible();

    // Tab past the end of the drawer's tab ring several times. Focus may land on
    // Base UI's own focus guards (that is how the trap wraps), but it must never
    // reach the routed page behind the scrim.
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press("Tab");
      const escaped = await page.evaluate(() => {
        const active = document.activeElement;
        if (!active || active === document.body) return false;
        return active.closest("[data-testid='screen']") !== null;
      });
      expect(escaped, `focus reached the page behind the drawer after ${i + 1} tabs`).toBe(false);
    }

    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test("the backdrop and the close control both dismiss the drawer", async ({ page }) => {
    await gotoReady(page, "/people");

    await page.getByTestId("mobile-nav-trigger").click();
    await expect(page.getByTestId("mobile-nav-drawer")).toBeVisible();
    await page.getByTestId("mobile-nav-close").click();
    await expect(page.getByTestId("mobile-nav-drawer")).toHaveCount(0);

    await page.getByTestId("mobile-nav-trigger").click();
    await expect(page.getByTestId("mobile-nav-drawer")).toBeVisible();
    // Press the scrim well to the right of the 250px drawer.
    await scrim(page).click({ position: { x: 450, y: 400 } });
    await expect(page.getByTestId("mobile-nav-drawer")).toHaveCount(0);
  });
});

test.describe("Requests overlays — the base layer and the reserved clear-confirm layer", () => {
  test("the cell editor is a base-layer overlay that Escape discards", async ({ page }) => {
    await gotoReady(page, "/shift-requests");
    await seed(page, REQUESTS_SEED);
    await expect(page.getByTestId("requests-matrix")).toBeVisible();

    const cell = page.getByTestId("cell-Aisha-01");
    await cell.click();
    const editor = page.getByTestId("cell-preference-editor");
    await expect(editor).toBeVisible();
    expect(await isPortaled(editor)).toBe(true);
    await expect(editor).toHaveAttribute("data-layer", "base");
    expect(await style(editor, "z-index")).toBe("50");

    // Stage a change, then dismiss implicitly: nothing may be written.
    await page.getByTestId("cell-editor-tab-leave").click();
    await page.keyboard.press("Escape");
    await expect(editor).toHaveCount(0);
    await expect(page.getByTestId("requests-count")).toHaveText("0");
    await expect(cell).not.toContainText("Leave");
  });

  test("the clear confirmation is the only overlay on the live route and owns the reserved layer", async ({
    page,
  }) => {
    await gotoReady(page, "/shift-requests");
    await seed(page, REQUESTS_SEED);
    await expect(page.getByTestId("requests-matrix")).toBeVisible();

    // Commit one real request first, so "nothing was cleared" below is a
    // statement about live data rather than about an already-empty matrix. The
    // base-layer editor that writes it has fully unmounted before the confirm
    // opens — which is precisely why z-60 is a RESERVED layer here, not a
    // concurrently exercised one.
    const cell = page.getByTestId("cell-Aisha-01");
    await cell.click();
    await page.getByTestId("cell-editor-tab-leave").click();
    await page.getByTestId("cell-editor-save").click();
    await expect(page.getByTestId("cell-preference-editor")).toHaveCount(0);
    await expect(page.getByTestId("requests-count")).toHaveText("1");
    await expect(cell).toContainText("Leave");

    // The exact invoking control, not "the first button in the panel".
    await page.getByTestId("requests-toggle-clear").click();
    const invoker = page.getByTestId("clear-data-button-All requests");
    await expect(invoker).toBeVisible();
    await invoker.click();

    const confirm = page.getByTestId("clear-confirm-dialog");
    await expect(confirm).toBeVisible();
    expect(await isPortaled(confirm)).toBe(true);
    await expect(confirm).toHaveAttribute("data-layer", "nested");
    await expect(scrim(page)).toHaveAttribute("data-layer", "nested");
    expect(await style(confirm, "z-index")).toBe("60");

    // The live route's reserved-layer fact: while this confirm is open it is the
    // ONLY overlay mounted — there is no concurrent base-layer dialog to stack
    // against. This is the assertion the previous "nested" framing overstated.
    expect(
      await page.evaluate(() => ({
        overlays: document.querySelectorAll(
          "[data-slot='dialog-overlay'], [data-slot='alert-dialog-overlay']",
        ).length,
        popups: document.querySelectorAll(
          "[data-slot='dialog-content'], [data-slot='alert-dialog-content']",
        ).length,
        baseLayerOverlays: document.querySelectorAll("[data-layer='base']").length,
      })),
    ).toEqual({ overlays: 1, popups: 1, baseLayerOverlays: 0 });

    // Hit-testing against the LIVE PAGE: the popup takes its own centre, and a
    // point over the live page but outside the popup resolves to the scrim
    // rather than to the page content beneath it. That sample point is a fixed
    // viewport corner, NOT a point inside the requests matrix — the matrix sits
    // below the fold at this viewport, so no matrix-relative point is reachable.
    const box = (await confirm.boundingBox())!;
    expect(await topmostAt(page, box.x + box.width / 2, box.y + 10)).toBe("clear-confirm-dialog");

    // A viewport point well clear of the popup: while the confirm is open the
    // reserved layer owns it, so the page content underneath is unreachable.
    const OUTSIDE_POPUP = { x: 20, y: 20 };
    expect(OUTSIDE_POPUP.x < box.x || OUTSIDE_POPUP.y < box.y).toBe(true);
    const slotAt = (point: { x: number; y: number }) =>
      page.evaluate(
        (p) => document.elementFromPoint(p.x, p.y)?.getAttribute("data-slot") ?? null,
        point,
      );
    expect(await slotAt(OUTSIDE_POPUP)).toBe("alert-dialog-overlay");

    // An implicit dismissal can never confirm a clear: the committed request and
    // the matrix both survive Escape.
    await page.keyboard.press("Escape");
    await expect(confirm).toHaveCount(0);
    await expect(page.getByTestId("requests-matrix")).toBeVisible();
    await expect(page.getByTestId("requests-count")).toHaveText("1");
    await expect(cell).toContainText("Leave");

    // The same point reaches the page again — proving the assertion above
    // discriminated the scrim from the content rather than matching anything.
    expect(await slotAt(OUTSIDE_POPUP)).not.toBe("alert-dialog-overlay");

    // Focus returns to the clear-data control that invoked the confirmation.
    await expect(invoker).toBeFocused();
  });

  test("the cell editor opens from the keyboard and returns focus to that exact cell", async ({
    page,
  }) => {
    await gotoReady(page, "/shift-requests");
    await seed(page, REQUESTS_SEED);
    await expect(page.getByTestId("requests-matrix")).toBeVisible();

    const cell = page.getByTestId("cell-Aisha-02");
    // The origin is a real control, not a bare div: a native button, focusable
    // and named, with its role implicit rather than asserted via ARIA.
    expect(await cell.evaluate((element) => element.tagName)).toBe("BUTTON");
    await expect(cell).toHaveAttribute("type", "button");
    await expect(cell).toHaveAccessibleName(/Aisha/);

    await cell.focus();
    await expect(cell).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("cell-preference-editor")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.getByTestId("cell-preference-editor")).toHaveCount(0);
    // The contract the round-four review found unimplemented: focus lands back on
    // the originating cell, not on `body`.
    await expect(cell).toBeFocused();
    expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe("BODY");
  });

  test("a pointer-opened cell editor also returns focus to that exact cell", async ({ page }) => {
    await gotoReady(page, "/shift-requests");
    await seed(page, REQUESTS_SEED);
    await expect(page.getByTestId("requests-matrix")).toBeVisible();

    const cell = page.getByTestId("cell-Aisha-03");
    await cell.click();
    await expect(page.getByTestId("cell-preference-editor")).toBeVisible();
    await page.getByTestId("cell-editor-cancel").click();
    await expect(page.getByTestId("cell-preference-editor")).toHaveCount(0);
    await expect(cell).toBeFocused();
  });

  test("the history editor opens from the keyboard and Done returns focus to that exact slot", async ({
    page,
  }) => {
    await gotoReady(page, "/shift-requests");
    await seed(page, REQUESTS_HISTORY_SEED);
    await expect(page.getByTestId("requests-matrix")).toBeVisible();

    // A populated slot, not padding: H-2 holds the older of Aisha's two entries.
    const slot = page.getByTestId("hist-Aisha-1");
    await expect(slot).toHaveText("PM");
    expect(await slot.evaluate((element) => element.tagName)).toBe("BUTTON");
    await expect(slot).toHaveAttribute("type", "button");
    await expect(slot).toHaveAccessibleName(/H-2/);

    await slot.focus();
    await page.keyboard.press("Enter");
    const editor = page.getByTestId("history-editor");
    await expect(editor).toBeVisible();
    expect(await isPortaled(editor)).toBe(true);
    await expect(editor).toHaveAccessibleName("Edit history");

    await page.getByTestId("history-editor-done").click();
    await expect(editor).toHaveCount(0);
    await expect(slot).toBeFocused();
    expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe("BODY");
  });

  test("a history option commits and still returns focus to that exact slot", async ({ page }) => {
    await gotoReady(page, "/shift-requests");
    await seed(page, REQUESTS_HISTORY_SEED);
    await expect(page.getByTestId("requests-matrix")).toBeVisible();

    const slot = page.getByTestId("hist-Aisha-1");
    await slot.click();
    await expect(page.getByTestId("history-editor")).toBeVisible();

    await page.getByTestId("history-editor-option-AM").click();
    await expect(page.getByTestId("history-editor")).toHaveCount(0);
    await expect(slot).toHaveText("AM");
    await expect(slot).toBeFocused();
  });

  test("quick-paint cells stay drag targets rather than becoming buttons", async ({ page }) => {
    await gotoReady(page, "/shift-requests");
    await seed(page, REQUESTS_SEED);
    await expect(page.getByTestId("requests-matrix")).toBeVisible();
    await page.getByTestId("requests-tab-quick").click();

    const cell = page.getByTestId("cell-Aisha-02");
    expect(await cell.evaluate((element) => element.tagName)).toBe("DIV");
    await expect(cell).not.toHaveAttribute("role", "button");
    expect(await cell.getAttribute("tabindex")).toBeNull();
  });

  test("the CSV modal closes on Escape, the backdrop and its close control", async ({ page }) => {
    await gotoReady(page, "/shift-requests");
    await seed(page, REQUESTS_SEED);
    await expect(page.getByTestId("requests-matrix")).toBeVisible();
    // FR-SR-34: both CSV controls exist only in Quick paint mode.
    await page.getByTestId("requests-tab-quick").click();

    const trigger = page.getByTestId("requests-open-history-csv");
    const modal = page.getByTestId("requests-csv-modal");

    await trigger.click();
    await expect(modal).toBeVisible();
    expect(await isPortaled(modal)).toBe(true);
    await page.keyboard.press("Escape");
    await expect(modal).toHaveCount(0);
    await expect(trigger).toBeFocused();

    await trigger.click();
    await expect(modal).toBeVisible();
    await page.getByTestId("requests-csv-modal-close").click();
    await expect(modal).toHaveCount(0);

    await trigger.click();
    await expect(modal).toBeVisible();
    await scrim(page).click({ position: { x: 5, y: 5 } });
    await expect(modal).toHaveCount(0);
  });
});

// Sequential, not stacked: the upload modal unmounts as the version gate opens,
// so this pair is a handover between two BASE-layer overlays.
test.describe("Save & Load — upload hands over to the version confirmation", () => {
  test("the upload modal restores focus to its trigger", async ({ page }) => {
    await gotoReady(page, "/save-and-load");
    const trigger = page.getByTestId("scenario-upload-button");
    await trigger.click();

    const modal = page.getByTestId("upload-modal");
    await expect(modal).toBeVisible();
    expect(await isPortaled(modal)).toBe(true);
    await expect(modal).toHaveAttribute("data-layer", "base");

    await page.keyboard.press("Escape");
    await expect(modal).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test("the version confirmation replaces the upload modal without losing focus", async ({
    page,
  }) => {
    await gotoReady(page, "/save-and-load");
    const trigger = page.getByTestId("scenario-upload-button");
    await trigger.click();
    await expect(page.getByTestId("upload-modal")).toBeVisible();

    await page.getByTestId("upload-file-input").setInputFiles({
      name: "no-version.yaml",
      mimeType: "text/yaml",
      buffer: Buffer.from(YAML_WITHOUT_VERSION),
    });

    const confirm = page.getByTestId("confirm-dialog");
    await expect(confirm).toBeVisible();
    expect(await isPortaled(confirm)).toBe(true);
    // The upload modal has handed over rather than stacking: the confirmation is
    // the only live overlay, and it stays on the BASE layer.
    await expect(page.getByTestId("upload-modal")).toHaveCount(0);
    await expect(confirm).toHaveAttribute("data-layer", "base");

    const box = await confirm.boundingBox();
    expect(box).not.toBeNull();
    expect(await topmostAt(page, box!.x + box!.width / 2, box!.y + 10)).toBe("confirm-dialog");

    // Focus is inside the confirmation, not stranded on the dismissed modal.
    expect(
      await page.evaluate(() => {
        const popup = document.querySelector("[data-testid='confirm-dialog']");
        return Boolean(popup && document.activeElement && popup.contains(document.activeElement));
      }),
    ).toBe(true);

    // Cancelling the gate returns focus to the control that began the flow.
    await page.getByTestId("confirm-dialog-cancel").click();
    await expect(confirm).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });
});

// The actionable Requests origins are native `<button type="button">` elements
// (quick win `ii7.9.5`). The claim that a native button would change the grid
// box was disproved by a cold probe, so these tests hold the platform semantics
// AND the measured geometry together — a regression in either is a failure.
//
// Explicitly NOT covered, and explicitly not fixed here: the product-scale tab
// order (every actionable cell is still an ordinary tab stop) and the
// disconnected-origin focus lifecycle. Both remain accepted P4 backlog items
// under the accessibility priority decision.
test.describe("Requests origins are native buttons with unchanged geometry", () => {
  /** The pre-fix matrix contract from the cold probe. */
  const REQUEST_CELL_BOX = { width: 56, height: 40 };

  test("a request cell is a native button whose box is exactly the pre-fix 56×40", async ({
    page,
  }) => {
    await gotoReady(page, "/shift-requests");
    await seed(page, REQUESTS_SEED);
    await expect(page.getByTestId("requests-matrix")).toBeVisible();

    const cell = page.getByTestId("cell-Aisha-02");
    const semantics = await cell.evaluate((element) => ({
      tagName: element.tagName,
      type: element.getAttribute("type"),
      role: element.getAttribute("role"),
    }));
    expect(semantics).toEqual({ tagName: "BUTTON", type: "button", role: null });

    const box = (await cell.boundingBox())!;
    expect(Math.round(box.width)).toBe(REQUEST_CELL_BOX.width);
    expect(Math.round(box.height)).toBe(REQUEST_CELL_BOX.height);

    // The computed layout/paint contract the div carried, still carried.
    const computed = await cell.evaluate((element) => {
      const s = getComputedStyle(element);
      return {
        display: s.display,
        alignItems: s.alignItems,
        justifyContent: s.justifyContent,
        padding: `${s.paddingTop} ${s.paddingRight} ${s.paddingBottom} ${s.paddingLeft}`,
        backgroundColor: s.backgroundColor,
        textAlign: s.textAlign,
        fontFamily: s.fontFamily,
        fontSize: s.fontSize,
        borderStyle: s.borderStyle,
      };
    });
    expect(computed.display).toBe("flex");
    expect(computed.alignItems).toBe("center");
    expect(computed.justifyContent).toBe("center");
    expect(computed.textAlign).toBe("center");
    // No UA button chrome survived Tailwind's preflight reset: the padding is
    // the app's own `px-1` (0.25rem through the v2 0.9 spacing multiplier =
    // 3.6px), not the UA's default button padding.
    expect(computed.padding).toBe("0px 3.6px 0px 3.6px");
    expect(computed.borderStyle).toBe("solid");
    // An empty cell paints no fill of its own — a UA button background would.
    expect(computed.backgroundColor).toBe("rgba(0, 0, 0, 0)");
    // Type is inherited from the app, not the UA's default button font.
    expect(computed.fontSize).toBe("10px");
  });

  test("a real history slot is a native button on the same row geometry", async ({ page }) => {
    await gotoReady(page, "/shift-requests");
    await seed(page, REQUESTS_HISTORY_SEED);
    await expect(page.getByTestId("requests-matrix")).toBeVisible();

    const slot = page.getByTestId("hist-Aisha-1");
    await expect(slot).toHaveText("PM");
    const semantics = await slot.evaluate((element) => ({
      tagName: element.tagName,
      type: element.getAttribute("type"),
      role: element.getAttribute("role"),
    }));
    expect(semantics).toEqual({ tagName: "BUTTON", type: "button", role: null });

    // History columns are narrower than date columns but share the row height,
    // so the sticky/row layout is unchanged by the element swap.
    const slotBox = (await slot.boundingBox())!;
    expect(Math.round(slotBox.height)).toBe(REQUEST_CELL_BOX.height);
    const rowBox = (await page.getByTestId("row-Aisha").boundingBox())!;
    expect(Math.round(rowBox.height)).toBe(REQUEST_CELL_BOX.height);
    expect(Math.round(slotBox.y)).toBe(Math.round(rowBox.y));
  });

  test("native pointer, Enter and Space each activate exactly once", async ({ page }) => {
    await gotoReady(page, "/shift-requests");
    await seed(page, REQUESTS_SEED);
    await expect(page.getByTestId("requests-matrix")).toBeVisible();

    const cell = page.getByTestId("cell-Aisha-02");
    const editor = page.getByTestId("cell-preference-editor");

    // Count real activations by counting opens: a double-fire would re-open the
    // dialog after the first close, which `toHaveCount(0)` would catch.
    await cell.click();
    await expect(editor).toBeVisible();
    await page.getByTestId("cell-editor-cancel").click();
    await expect(editor).toHaveCount(0);

    await cell.focus();
    await page.keyboard.press("Enter");
    await expect(editor).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(editor).toHaveCount(0);

    await cell.focus();
    await page.keyboard.press(" ");
    await expect(editor).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(editor).toHaveCount(0);
  });

  test("Space activates without scrolling the matrix or the page", async ({ page }) => {
    await gotoReady(page, "/shift-requests");
    await seed(page, REQUESTS_SEED);
    await expect(page.getByTestId("requests-matrix")).toBeVisible();

    const cell = page.getByTestId("cell-Aisha-02");
    await cell.focus();
    const before = await page.evaluate(() => ({
      page: window.scrollY,
      matrix: document.querySelector("[data-testid='requests-matrix']")?.scrollTop ?? 0,
    }));

    await page.keyboard.press(" ");
    await expect(page.getByTestId("cell-preference-editor")).toBeVisible();

    const after = await page.evaluate(() => ({
      page: window.scrollY,
      matrix: document.querySelector("[data-testid='requests-matrix']")?.scrollTop ?? 0,
    }));
    // A native button consumes Space itself; nothing scrolled underneath.
    expect(after).toEqual(before);
  });
});

// The two compact weight fields carry the only control-height override inside an
// F3 overlay. F4's custom-spacing merge registration made that override newly
// effective at 30.6px (8.5 × the 0.9-baked spacing unit), under the 32px precise
// floor — so both pointer classes are measured here against the live control,
// not inferred from a class name.
test.describe("Cell Preference weight fields keep the control floor", () => {
  const PRECISE_FLOOR = 32;

  async function openWeightFields(page: Page) {
    await gotoReady(page, "/shift-requests");
    await seed(page, REQUESTS_SEED);
    await expect(page.getByTestId("requests-matrix")).toBeVisible();
    await page.getByTestId("cell-Aisha-01").click();
    await expect(page.getByTestId("cell-preference-editor")).toBeVisible();
  }

  test("both fields clear 32px on a precise pointer", async ({ page }) => {
    await openWeightFields(page);
    expect(await page.evaluate(() => matchMedia("(pointer: fine)").matches)).toBe(true);

    const weight = page.getByTestId("cell-editor-weight-input-AM");
    const weightBox = (await weight.boundingBox())!;
    expect(weightBox.height).toBeGreaterThanOrEqual(PRECISE_FLOOR);
    // The canonical token resolves to exactly --ctl-sm, not a spacing step.
    expect(await style(weight, "height")).toBe("32px");

    await page.getByTestId("cell-editor-tab-off").click();
    const off = page.getByTestId("cell-editor-off-weight-input");
    const offBox = (await off.boundingBox())!;
    expect(offBox.height).toBeGreaterThanOrEqual(PRECISE_FLOOR);
    expect(await style(off, "height")).toBe("32px");
  });

  test("the fields remain usable and the editor still commits at that size", async ({ page }) => {
    await openWeightFields(page);
    const weight = page.getByTestId("cell-editor-weight-input-AM");
    await weight.fill("5");
    await page.getByTestId("cell-editor-save").click();
    await expect(page.getByTestId("cell-preference-editor")).toHaveCount(0);
    await expect(page.getByTestId("requests-count")).toHaveText("1");
  });
});

test.describe("Cell Preference weight fields on a coarse pointer", () => {
  test.use({ viewport: { width: 393, height: 851 }, hasTouch: true, isMobile: true });

  test("both fields reach a real 44px touch target", async ({ page }) => {
    await gotoReady(page, "/shift-requests");
    await seed(page, REQUESTS_SEED);
    await expect(page.getByTestId("requests-matrix")).toBeVisible();
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);

    await page.getByTestId("cell-Aisha-01").click();
    await expect(page.getByTestId("cell-preference-editor")).toBeVisible();

    // `h-control-sm` sets height and `pointer-coarse:min-h-touch` sets the floor,
    // so the coarse minimum wins on the real control rather than on a hitbox.
    const weightBox = (await page.getByTestId("cell-editor-weight-input-AM").boundingBox())!;
    expect(weightBox.height).toBeGreaterThanOrEqual(44);

    await page.getByTestId("cell-editor-tab-off").click();
    const offBox = (await page.getByTestId("cell-editor-off-weight-input").boundingBox())!;
    expect(offBox.height).toBeGreaterThanOrEqual(44);
  });
});

test.describe("overlay controls on a coarse pointer", () => {
  // Emulated touch/mobile rather than a spread device descriptor: a device
  // preset also carries `defaultBrowserType`, which Playwright refuses inside a
  // describe group. These three options are what actually flip `pointer: coarse`.
  test.use({ viewport: { width: 393, height: 851 }, hasTouch: true, isMobile: true });

  test("the dialog's own close control reaches the 44px minimum", async ({ page }) => {
    await gotoReady(page, "/save-and-load");
    await page.getByTestId("scenario-upload-button").click();
    await expect(page.getByTestId("upload-modal")).toBeVisible();

    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);

    const close = page.getByTestId("upload-modal-close");
    const box = await close.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);

    // The overlay itself must not overflow a narrow viewport.
    const modal = await page.getByTestId("upload-modal").boundingBox();
    expect(modal!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  });
});
