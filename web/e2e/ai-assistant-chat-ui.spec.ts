import { expect, test, type Page } from "@playwright/test";

// T11 / t34.12.1.30 -- THE SHIPPED ASSISTANT CHAT UI, IN A REAL BROWSER AGAINST A
// PRODUCTION BUILD.
//
// WHY THIS LAYER, AND WHY IT CANNOT BE ANYTHING ELSE. The defect this covers was a
// missing STYLESHEET: production rendered `CopilotChatView` without
// `@copilotkit/react-core/v2/styles.css`, so every `cpk:*` class in the library's
// markup was an inert string. The DOM was correct, the component tree was correct,
// every unit and component test passed, and the panel was unusable -- the transcript
// had no scroll bound, the composer's three-column grid stacked into three rows 227px
// BELOW the dock's bottom edge, and the message bubbles had neither fill nor radius.
//
// Nothing that does not resolve real CSS can see any of that. jsdom does not lay out,
// so a component test cannot tell a flex row from three stacked blocks; a static
// contract can prove the import exists but not that the result is usable.
// `components/ai/assistant-styles.test.ts` owns the first half (the import, its
// position, the scoping and the completeness of the token mapping) and this file owns
// the second: measured layout and computed paint, on the production bundle.
//
// EVERY ASSERTION IS MEASURED, NOT SNAPSHOTTED. There is no screenshot baseline here
// on purpose -- a pixel diff would have failed for the original defect and for a
// harmless font-metric change alike, and could not say which. Boxes, computed styles
// and scroll geometry name what is wrong.
//
// NO LIVE PROVIDER. The two same-origin setup routes are fulfilled in the browser and
// the conversation is seeded through the assistant test bridge's REAL fenced write, so
// what renders is a genuine persisted thread replayed by the shipped hydration path.

const SENTINEL_KEY = "sk-or-v1-E2E-SENTINEL-DO-NOT-LEAK-000000000000";
const SENTINEL_MODEL = "anthropic/claude-sonnet-4.5";

/** The dock's own pivot, from `components/ai/assistant-panel.tsx`. */
const WIDE_VIEWPORT = { width: 1280, height: 720 };
const NARROW_VIEWPORT = { width: 390, height: 844 };

type NsWindow = {
  __nsStore: {
    authority(): { scenarioId: string | null; ownership: string };
    commands: { mutate(patch: Record<string, unknown>): Promise<{ ok: boolean }> };
    drain(): Promise<void>;
    capabilityStamp(): { appBuildVersion: string; manifestSha256: string };
    assistantProposal: {
      prepare(
        input: Record<string, unknown>,
      ): Promise<{ ok: boolean; reason?: string; proposal?: { proposalId: string } }>;
      apply(input: {
        proposalId: string;
        receiptId: string;
      }): Promise<{ ok: boolean; reason?: string }>;
    };
  };
  __nsAssistant: {
    ready(): boolean;
    selectThread(scenarioId: string): Promise<{ threadId: string }>;
    appendMessage(input: {
      threadId: string;
      scenarioId: string;
      messageId: string;
      content: string;
      role?: "user" | "assistant";
    }): Promise<string>;
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

/**
 * Two full turns on disk, through the real fenced write.
 *
 * Long, wrapping, Markdown-bearing content is the point, not decoration: a thread of
 * one-line messages cannot fail "the transcript is a bounded scroll region", and a
 * thread without a fenced code block or a list cannot fail "Markdown is coherent". A
 * seeded thread is also the only way to render a transcript at all without a live
 * model, and it exercises the shipped hydration path (`readThreadMessages` ->
 * `toTransportThread` -> `publishVisible`) rather than injecting into the view.
 */
async function seedConversation(page: Page) {
  const outcomes = await page.evaluate(async () => {
    const ns = window as unknown as NsWindow;
    const scenarioId = ns.__nsStore.authority().scenarioId as string;
    const thread = await ns.__nsAssistant.selectThread(scenarioId);
    const turns: [string, "user" | "assistant", string][] = [
      ["ui-1", "user", "Which nurses are short on Tuesday the 14th, and why exactly?"],
      [
        "ui-2",
        "assistant",
        "Tuesday 14 April is short by **two** late shifts.\n\n" +
          "- Late (L) needs 4, has 2\n" +
          "- Night (N) needs 2, has 2\n\n" +
          "Both unfilled late slots are blocked by the `max_consecutive_lates` rule for " +
          "A. Ferreira and J. Okonkwo, whose preceding three days are already late shifts. " +
          "This sentence exists to run past the dock width several times over, so that " +
          "wrapping, line spacing and the right-hand inset are measured on genuinely " +
          "multi-line prose rather than on a single short line that would fit either way.",
      ],
      ["ui-3", "user", "And the weekend after that one, including the Sunday night run?"],
      [
        "ui-4",
        "assistant",
        "The weekend of 18-19 April is fully covered. This is the check it comes from:\n\n" +
          "```python\n" +
          "for day in period.days:\n" +
          "    if coverage[day] < requirement[day]:\n" +
          "        yield Shortfall(day=day, gap=requirement[day] - coverage[day])\n" +
          "```\n\n" +
          "Nothing else in the period is outstanding.",
      ],
    ];
    const results: string[] = [];
    for (const [id, role, content] of turns) {
      results.push(
        await ns.__nsAssistant.appendMessage({
          threadId: thread.threadId,
          scenarioId,
          messageId: id,
          content,
          role,
        }),
      );
    }
    return results;
  });
  // Non-vacuity: if the seed were silently fenced or dropped, every layout assertion
  // below would be measuring an EMPTY transcript and would pass for the wrong reason.
  expect(outcomes).toEqual(["accepted", "accepted", "accepted", "accepted"]);
}

/** The measured facts one (surface x theme) case asserts against. */
interface ChatFacts {
  theme: { darkClass: boolean; panelBackground: string };
  tokens: {
    surface: string;
    panel: string;
    ink: string;
    line: string;
    brand: string;
    onbrand: string;
    controlRadius: string;
    pillRadius: string;
  };
  panel: { width: number; height: number; scrollWidth: number; clientWidth: number };
  transcript: {
    found: boolean;
    overflowY: string;
    scrollHeight: number;
    clientHeight: number;
    scrollWidth: number;
    clientWidth: number;
    scrolledTo: number;
    withinPanel: boolean;
  };
  userBubble: {
    found: boolean;
    background: string;
    borderRadius: string;
    fontFamily: string;
    color: string;
    width: number;
    transcriptWidth: number;
    /** Bubble left edge minus assistant-prose left edge: > 0 means inset/right-aligned. */
    insetFromAssistant: number;
    withinTranscript: boolean;
  };
  assistantProse: {
    found: boolean;
    background: string;
    color: string;
    fontFamily: string;
    lineCount: number;
  };
  codeBlock: {
    found: boolean;
    monoFamily: string;
    ownScroller: boolean;
    withinTranscript: boolean;
    /** The first highlighted token's computed colour, so the two themes can be compared. */
    tokenColor: string;
  };
  /** Descendants of the transcript whose box escapes its content column. */
  transcriptOverflowers: string[];
  copyControl: {
    found: boolean;
    tag: string;
    width: number;
    height: number;
    background: string;
    borderRadius: string;
    borderColor: string;
    withinTranscript: boolean;
  };
  composer: {
    found: boolean;
    background: string;
    borderRadius: string;
    borderColor: string;
    withinPanel: boolean;
    textboxWithin: boolean;
    sendWithin: boolean;
    /** Absolute difference of the textbox and send-control vertical centres. */
    rowOffset: number;
    /** Vertical gap between the textbox box and the send-control box, 0 when they share a row. */
    controlGap: number;
    count: number;
    attachmentWithin: boolean;
    textboxHeight: number;
    sendWidth: number;
    sendHeight: number;
    sendBackground: string;
    sendColor: string;
    sendRadius: string;
    sendVisible: boolean;
    placeholderColor: string;
    height: number;
  };
  /** Every opaque-or-translucent zero-channel black or hardcoded grey still painted. */
  offSystemPaint: string[];
}

/**
 * Read every fact this spec asserts, in one pass, from the live document.
 *
 * TOKENS ARE RESOLVED THROUGH A PROBE ELEMENT rather than read as raw text. A
 * `getPropertyValue("--panel")` returns the authored `#eef3f0`, which no computed
 * style is ever equal to; painting `var(--panel)` onto a throwaway child of the panel
 * and reading it back yields the same `rgb(...)` form the assertions compare against,
 * resolves per theme automatically, and cannot be satisfied by a hardcoded literal
 * that merely LOOKS like the token.
 */
async function readChatFacts(page: Page, panelTestId: string): Promise<ChatFacts> {
  return page.evaluate((testId) => {
    const panel = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)!;

    const probe = document.createElement("div");
    probe.style.position = "absolute";
    probe.style.visibility = "hidden";
    panel.append(probe);
    const resolve = (property: "backgroundColor" | "borderRadius", value: string): string => {
      probe.style.cssText = "position:absolute;visibility:hidden";
      probe.style[property] = value;
      return getComputedStyle(probe)[property];
    };
    const color = (value: string) => resolve("backgroundColor", value);
    const radius = (value: string) => resolve("borderRadius", value);

    const tokens = {
      surface: color("var(--surface)"),
      panel: color("var(--panel)"),
      ink: color("var(--ink)"),
      line: color("var(--line)"),
      brand: color("var(--brand)"),
      onbrand: color("var(--onbrand)"),
      controlRadius: radius("var(--r-ctl)"),
      pillRadius: radius("var(--r-pill)"),
    };
    probe.remove();

    const box = (el: Element) => el.getBoundingClientRect();
    const contains = (outer: Element, inner: Element, slack = 1) => {
      const o = box(outer);
      const i = box(inner);
      return (
        i.left >= o.left - slack &&
        i.right <= o.right + slack &&
        i.top >= o.top - slack &&
        i.bottom <= o.bottom + slack
      );
    };

    // The transcript's scroller is whichever ancestor of the message list actually
    // scrolls. Found by walking up rather than named by class, so the assertion keeps
    // meaning if the library re-nests its own wrappers.
    const messageList = document.querySelector<HTMLElement>('[data-testid="copilot-message-list"]');
    let scroller: HTMLElement | null = null;
    for (let el = messageList?.parentElement ?? null; el && el !== panel; el = el.parentElement) {
      const overflow = getComputedStyle(el).overflowY;
      if ((overflow === "auto" || overflow === "scroll") && el.scrollHeight > el.clientHeight) {
        scroller = el;
        break;
      }
    }
    let scrolledTo = 0;
    if (scroller) {
      scroller.scrollTop = scroller.scrollHeight;
      scrolledTo = scroller.scrollTop;
      scroller.scrollTop = 0;
    }

    const userMessage = document.querySelector<HTMLElement>('[data-testid="copilot-user-message"]');
    // The bubble is the filled descendant: the one element whose background differs
    // from the plane it sits on. Identified by what makes it a bubble, not by a class.
    const panelBackground = getComputedStyle(panel).backgroundColor;
    const bubble =
      Array.from(userMessage?.querySelectorAll<HTMLElement>("*") ?? []).find((el) => {
        const background = getComputedStyle(el).backgroundColor;
        return (
          background !== "rgba(0, 0, 0, 0)" &&
          background !== "transparent" &&
          background !== panelBackground &&
          el.getBoundingClientRect().height > 0
        );
      }) ?? null;

    const assistantMessage = document.querySelector<HTMLElement>(
      '[data-testid="copilot-assistant-message"]',
    );
    // The TALLEST paragraph, not the first: the first is a one-line summary, and
    // "prose genuinely wraps at this width" has to be measured on the long one.
    const assistantProse =
      Array.from(assistantMessage?.querySelectorAll<HTMLElement>("p") ?? []).sort(
        (left, right) => box(right).height - box(left).height,
      )[0] ?? null;

    const pre = document.querySelector<HTMLElement>("[data-copilotkit] pre");

    const copyControl = document.querySelector<HTMLElement>('[data-testid="copilot-copy-button"]');

    const composer = document.querySelector<HTMLElement>('[data-testid="copilot-chat-input"]');
    const textbox = document.querySelector<HTMLElement>('[data-testid="copilot-chat-textarea"]');
    const send = document.querySelector<HTMLElement>('[data-testid="copilot-send-button"]');
    const attachment = document.querySelector<HTMLElement>(
      '[data-testid="copilot-add-menu-button"]',
    );
    const centreY = (el: Element) => {
      const b = box(el);
      return b.top + b.height / 2;
    };

    // THE NO-BLACK SWEEP, over every element the panel actually renders. The library
    // hardcodes `cpk:bg-black`, `cpk:text-white`, `#00000014`, `#00000077` and
    // `rgb(93,93,93)` in its own control variants, and none of those is reachable
    // through its theme variables -- so "the tokens are mapped" does not imply "no
    // off-system paint remains". This looks for what is PAINTED.
    const isZeroChannel = (value: string) => {
      const match = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(value);
      if (!match) return false;
      const alpha = match[4] === undefined ? 1 : Number(match[4]);
      return alpha > 0 && match[1] === "0" && match[2] === "0" && match[3] === "0";
    };
    const HARDCODED_GREYS = new Set([
      "rgb(93, 93, 93)",
      "rgb(68, 68, 68)",
      "rgb(51, 51, 51)",
      "rgb(13, 13, 13)",
      "rgb(243, 243, 243)",
      "rgb(232, 232, 232)",
      "rgb(48, 48, 48)",
      "rgb(64, 64, 64)",
      "rgb(69, 69, 69)",
      "rgb(248, 248, 248)",
    ]);
    const offSystemPaint: string[] = [];
    for (const el of [panel, ...Array.from(panel.querySelectorAll("*"))]) {
      const style = getComputedStyle(el);
      const placeholder = getComputedStyle(el, "::placeholder").color;
      const label = el.getAttribute("data-testid") ?? el.tagName.toLowerCase();
      for (const [property, value] of [
        ["color", style.color],
        ["background-color", style.backgroundColor],
        ["border-top-color", style.borderTopColor],
        ["outline-color", style.outlineColor],
        ["placeholder", placeholder],
      ] as const) {
        if (isZeroChannel(value) || HARDCODED_GREYS.has(value)) {
          offSystemPaint.push(`${label}: ${property}=${value}`);
        }
      }
    }

    return {
      theme: {
        darkClass: document.documentElement.classList.contains("dark"),
        panelBackground,
      },
      tokens,
      panel: {
        width: box(panel).width,
        height: box(panel).height,
        scrollWidth: panel.scrollWidth,
        clientWidth: panel.clientWidth,
      },
      transcript: {
        found: scroller !== null,
        overflowY: scroller ? getComputedStyle(scroller).overflowY : "",
        scrollHeight: scroller?.scrollHeight ?? 0,
        clientHeight: scroller?.clientHeight ?? 0,
        scrollWidth: scroller?.scrollWidth ?? 0,
        clientWidth: scroller?.clientWidth ?? 0,
        scrolledTo,
        withinPanel: scroller ? contains(panel, scroller) : false,
      },
      userBubble: {
        found: bubble !== null,
        background: bubble ? getComputedStyle(bubble).backgroundColor : "",
        borderRadius: bubble ? getComputedStyle(bubble).borderTopLeftRadius : "",
        fontFamily: bubble ? getComputedStyle(bubble).fontFamily : "",
        color: bubble ? getComputedStyle(bubble).color : "",
        width: bubble ? box(bubble).width : 0,
        transcriptWidth: messageList ? box(messageList).width : 0,
        insetFromAssistant:
          bubble && assistantProse ? box(bubble).left - box(assistantProse).left : 0,
        withinTranscript: bubble && messageList ? contains(messageList, bubble) : false,
      },
      assistantProse: {
        found: assistantProse !== null,
        background: assistantProse ? getComputedStyle(assistantProse).backgroundColor : "",
        color: assistantProse ? getComputedStyle(assistantProse).color : "",
        fontFamily: assistantProse ? getComputedStyle(assistantProse).fontFamily : "",
        lineCount: assistantProse
          ? Math.round(
              box(assistantProse).height /
                Number.parseFloat(getComputedStyle(assistantProse).lineHeight || "1"),
            )
          : 0,
      },
      codeBlock: {
        found: pre !== null,
        monoFamily: pre ? getComputedStyle(pre).fontFamily : "",
        ownScroller: pre ? pre.scrollWidth > pre.clientWidth : false,
        withinTranscript:
          pre?.parentElement && messageList ? contains(messageList, pre.parentElement) : false,
        tokenColor: (() => {
          const token = pre?.querySelector<HTMLElement>("span[style]");
          return token ? getComputedStyle(token).color : "";
        })(),
      },
      transcriptOverflowers: messageList
        ? Array.from(messageList.querySelectorAll<HTMLElement>("*"))
            .filter((el) => {
              const inner = box(el);
              if (inner.width === 0) return false;
              const outer = box(messageList);
              if (inner.right <= outer.right + 1 && inner.left >= outer.left - 1) return false;
              // A long code line running past its block is CORRECT -- the block clips or
              // scrolls it. Only content that escapes into the transcript's own painted
              // area counts, so anything already bounded by a clipping ancestor is not
              // an overflower.
              for (
                let ancestor = el.parentElement;
                ancestor && ancestor !== messageList;
                ancestor = ancestor.parentElement
              ) {
                const overflowX = getComputedStyle(ancestor).overflowX;
                if (overflowX === "auto" || overflowX === "scroll" || overflowX === "hidden") {
                  return false;
                }
              }
              return true;
            })
            .map((el) => `${el.getAttribute("data-testid") ?? el.tagName.toLowerCase()}`)
            .slice(0, 8)
        : [],
      copyControl: {
        found: copyControl !== null,
        tag: copyControl?.tagName.toLowerCase() ?? "",
        width: copyControl ? box(copyControl).width : 0,
        height: copyControl ? box(copyControl).height : 0,
        background: copyControl ? getComputedStyle(copyControl).backgroundColor : "",
        borderRadius: copyControl ? getComputedStyle(copyControl).borderTopLeftRadius : "",
        borderColor: copyControl ? getComputedStyle(copyControl).borderTopColor : "",
        withinTranscript:
          copyControl && messageList ? contains(messageList, copyControl, 6) : false,
      },
      composer: {
        found: composer !== null,
        background: composer ? getComputedStyle(composer).backgroundColor : "",
        borderRadius: composer ? getComputedStyle(composer).borderTopLeftRadius : "",
        borderColor: composer ? getComputedStyle(composer).borderTopColor : "",
        withinPanel: composer ? contains(panel, composer) : false,
        textboxWithin: composer && textbox ? contains(composer, textbox) : false,
        sendWithin: composer && send ? contains(composer, send) : false,
        rowOffset: textbox && send ? Math.abs(centreY(textbox) - centreY(send)) : Number.NaN,
        controlGap:
          textbox && send
            ? Math.max(0, box(send).top - box(textbox).bottom, box(textbox).top - box(send).bottom)
            : Number.NaN,
        count: document.querySelectorAll('[data-testid="copilot-chat-input"]').length,
        attachmentWithin: composer && attachment ? contains(composer, attachment) : false,
        textboxHeight: textbox ? box(textbox).height : 0,
        sendWidth: send ? box(send).width : 0,
        sendHeight: send ? box(send).height : 0,
        sendBackground: send ? getComputedStyle(send).backgroundColor : "",
        sendColor: send ? getComputedStyle(send).color : "",
        sendRadius: send ? getComputedStyle(send).borderTopLeftRadius : "",
        sendVisible: send
          ? box(send).width > 0 && getComputedStyle(send).visibility === "visible"
          : false,
        placeholderColor: textbox ? getComputedStyle(textbox, "::placeholder").color : "",
        height: composer ? box(composer).height : 0,
      },
      offSystemPaint,
    };
  }, panelTestId);
}

/** The whole assertion set, applied identically to every surface and theme. */
function assertCoherentChatUi(facts: ChatFacts, surface: "dock" | "sheet") {
  // --- the transcript is a BOUNDED SCROLL REGION -------------------------------
  //
  // All four clauses are needed. Without the stylesheet the scroller existed but had
  // `overflow-y: visible`, so the CONTENT grew the panel instead: the panel's own
  // scrollHeight ran 366px past its client height and the composer left the viewport.
  expect(facts.transcript.found).toBe(true);
  expect(["auto", "scroll"]).toContain(facts.transcript.overflowY);
  expect(facts.transcript.scrollHeight).toBeGreaterThan(facts.transcript.clientHeight + 8);
  expect(facts.transcript.scrolledTo).toBeGreaterThan(0);
  expect(facts.transcript.withinPanel).toBe(true);
  // The PANEL does not scroll -- the region inside it does.
  expect(facts.panel.scrollWidth).toBeLessThanOrEqual(facts.panel.clientWidth + 1);

  // --- no horizontal overflow ---------------------------------------------------
  expect(facts.transcript.scrollWidth).toBeLessThanOrEqual(facts.transcript.clientWidth + 1);

  // --- user and assistant turns are DISTINCT and readable -----------------------
  expect(facts.userBubble.found).toBe(true);
  // The well tone, at the control radius, contained and inset from the assistant's
  // own left edge. Unstyled, this element had a transparent background, a 0px radius
  // and the full transcript width -- indistinguishable from the assistant's prose.
  expect(facts.userBubble.background).toBe(facts.tokens.panel);
  expect(facts.userBubble.borderRadius).toBe(facts.tokens.controlRadius);
  expect(facts.userBubble.width).toBeLessThan(facts.userBubble.transcriptWidth);
  expect(facts.userBubble.insetFromAssistant).toBeGreaterThan(16);
  expect(facts.userBubble.withinTranscript).toBe(true);
  // next/font/local names the family after its variable (`hankenGrotesk`), not "Hanken Grotesk".
  expect(facts.userBubble.fontFamily).toMatch(/hanken ?grotesk/i);

  expect(facts.assistantProse.found).toBe(true);
  // The assistant speaks in the app's own voice: warm ink, no bubble.
  expect(facts.assistantProse.color).toBe(facts.tokens.ink);
  expect(facts.assistantProse.background).toBe("rgba(0, 0, 0, 0)");
  expect(facts.assistantProse.fontFamily).toMatch(/hanken ?grotesk/i);
  // Genuinely wrapped prose, so the layout facts above are not about one short line.
  expect(facts.assistantProse.lineCount).toBeGreaterThan(2);

  // --- Markdown: code is mono, contained, and scrolls itself, not the panel ------
  //
  // A long code line must move INSIDE its own block. Left to the panel it would
  // either force horizontal page scroll or be silently cut (DESIGN.md §7 note 6).
  expect(facts.codeBlock.found).toBe(true);
  expect(facts.codeBlock.monoFamily).toMatch(/spline ?sans ?mono/i);
  expect(facts.codeBlock.ownScroller).toBe(true);
  expect(facts.codeBlock.withinTranscript).toBe(true);

  // --- copy controls are CONTAINED CONTROLS, not bare glyphs on their own line ---
  expect(facts.copyControl.found).toBe(true);
  expect(facts.copyControl.tag).toBe("button");
  expect(facts.copyControl.background).toBe(facts.tokens.surface);
  expect(facts.copyControl.borderColor).toBe(facts.tokens.line);
  expect(facts.copyControl.borderRadius).toBe(facts.tokens.pillRadius);
  expect(facts.copyControl.width).toBeGreaterThanOrEqual(28);
  expect(facts.copyControl.height).toBeGreaterThanOrEqual(28);
  expect(facts.copyControl.withinTranscript).toBe(true);

  // NOTHING in the transcript hangs outside its own column. The library's toolbars
  // are laid out with 5px negative side margins, which was invisible while the copy
  // controls were bare glyphs and put a bordered pill outside the prose once they
  // were not -- and was the residual 5px of horizontal overflow.
  expect(facts.transcriptOverflowers).toEqual([]);

  // --- the composer is ONE usable region inside the panel -----------------------
  //
  // ONE region, not one ROW. The library ships a compact single-row layout and an
  // expanded two-row one (textbox above, controls below) and chooses between them
  // itself -- the dock rests compact, the wider sheet rests expanded. Pinning either
  // would pin a library layout decision this repair has no business owning, so what is
  // asserted is the property the defect actually violated: there is exactly ONE
  // composer container, it is inside the panel, every control is inside it, the
  // controls are adjacent rather than separated by other content, and the whole thing
  // stays a composer instead of taking over the panel. Before the repair the container
  // sat 227px BELOW the panel's bottom edge with its grid collapsed into three
  // full-width strips.
  expect(facts.composer.found).toBe(true);
  expect(facts.composer.count).toBe(1);
  expect(facts.composer.withinPanel).toBe(true);
  expect(facts.composer.textboxWithin).toBe(true);
  expect(facts.composer.sendWithin).toBe(true);
  expect(facts.composer.attachmentWithin).toBe(true);
  expect(facts.composer.controlGap).toBeLessThanOrEqual(24);
  expect(facts.composer.height).toBeLessThan(facts.panel.height * 0.45);
  expect(facts.composer.textboxHeight).toBeGreaterThanOrEqual(20);
  expect(facts.composer.background).toBe(facts.tokens.surface);
  expect(facts.composer.borderColor).toBe(facts.tokens.line);
  expect(facts.composer.borderRadius).toBe(facts.tokens.controlRadius);

  // The send/Stop affordance is present, sized as a real control, and reads as the
  // primary action in the live accent rather than the library's `cpk:bg-black`.
  expect(facts.composer.sendVisible).toBe(true);
  expect(facts.composer.sendBackground).toBe(facts.tokens.brand);
  expect(facts.composer.sendColor).toBe(facts.tokens.onbrand);
  expect(facts.composer.sendRadius).toBe(facts.tokens.pillRadius);
  const minimumTarget = surface === "sheet" ? 32 : 32;
  expect(facts.composer.sendWidth).toBeGreaterThanOrEqual(minimumTarget);
  expect(facts.composer.sendHeight).toBeGreaterThanOrEqual(minimumTarget);

  // --- nothing off-system is painted anywhere in the panel ----------------------
  expect(facts.offSystemPaint).toEqual([]);
}

/**
 * The typed composer, which is a different layout, and still has to be contained.
 *
 * The library expands to two rows once the textbox has content. That is its design and
 * this repair does not fight it -- but the expansion is exactly the moment the broken
 * build sprawled, so the containment claims are re-measured rather than assumed to
 * carry over from the resting state.
 */
function assertTypedComposerStaysContained(facts: ChatFacts) {
  expect(facts.composer.withinPanel).toBe(true);
  expect(facts.composer.textboxWithin).toBe(true);
  expect(facts.composer.sendWithin).toBe(true);
  expect(facts.composer.sendVisible).toBe(true);
  expect(facts.composer.sendBackground).toBe(facts.tokens.brand);
  expect(facts.composer.sendColor).toBe(facts.tokens.onbrand);
  // Still a composer rather than a page: the expanded row must not take over the
  // panel, and the transcript above it must still be a bounded scroller.
  expect(facts.composer.height).toBeLessThan(facts.panel.height * 0.45);
  expect(facts.panel.scrollWidth).toBeLessThanOrEqual(facts.panel.clientWidth + 1);
  expect(facts.transcript.found).toBe(true);
  expect(facts.offSystemPaint).toEqual([]);
}

for (const theme of ["light", "dark"] as const) {
  test.describe(`the shipped assistant chat UI (${theme})`, () => {
    test.beforeEach(async ({ page }, testInfo) => {
      testInfo.setTimeout(120_000);
      await page.addInitScript(
        ([selected]) => {
          (window as unknown as { __NS_ENABLE_TEST_BRIDGE?: boolean }).__NS_ENABLE_TEST_BRIDGE =
            true;
          // The SHIPPED restore path: the persisted preference is what the pre-paint
          // script in `components/theme/theme-script.tsx` reads to class <html>.
          // Nothing here touches the class directly.
          try {
            window.localStorage.setItem("ns-theme", selected);
          } catch {
            /* a profile without storage still runs the light case */
          }
        },
        [theme] as const,
      );
      await stubCatalog(page);
      await stubProbe(page);
    });

    test("the desktop dock is coherent, bounded and usable", async ({ page }) => {
      await page.setViewportSize(WIDE_VIEWPORT);
      await activate(page);
      await gotoReadyShell(page, "/dates");
      await seedConversation(page);

      await page.getByTestId("assistant-launcher").click();
      await expect(page.getByTestId("assistant-dock")).toBeVisible();
      await expect(page.getByTestId("copilot-message-list")).toBeVisible();
      // Markdown code blocks are highlighted asynchronously, so the `<pre>` the
      // Markdown assertions measure is not in the tree on the first paint.
      await expect(page.locator("[data-copilotkit] pre")).toBeAttached();

      const facts = await readChatFacts(page, "assistant-dock");
      expect(facts.theme.darkClass).toBe(theme === "dark");
      // The dock is the 384px `w-96` column on this system's 0.9 baseline. Asserted so
      // a case that silently rendered the full-width sheet cannot pass as the dock.
      expect(facts.panel.width).toBeGreaterThan(300);
      expect(facts.panel.width).toBeLessThan(400);
      assertCoherentChatUi(facts, "dock");

      // A typed composer is the state the send control is ENABLED in, which is what
      // makes "send is visible and reads as the primary action" a claim about the
      // affordance a nurse actually reaches for.
      await page.getByTestId("copilot-chat-textarea").fill("and the Monday after that one?");
      await expect(page.getByTestId("copilot-send-button")).toBeEnabled();
      assertTypedComposerStaysContained(await readChatFacts(page, "assistant-dock"));
    });

    test("the narrow sheet is coherent, bounded and usable", async ({ page }) => {
      await page.setViewportSize(NARROW_VIEWPORT);
      await activate(page);
      await gotoReadyShell(page, "/dates");
      await seedConversation(page);

      await page.getByTestId("assistant-launcher").click();
      await expect(page.getByTestId("assistant-sheet")).toBeVisible();
      await expect(page.getByTestId("copilot-message-list")).toBeVisible();
      await expect(page.locator("[data-copilotkit] pre")).toBeAttached();

      const facts = await readChatFacts(page, "assistant-sheet");
      expect(facts.theme.darkClass).toBe(theme === "dark");
      // The sheet takes the whole narrow viewport, so the same assertions are being
      // measured on a genuinely different geometry from the dock case.
      expect(facts.panel.width).toBe(NARROW_VIEWPORT.width);
      assertCoherentChatUi(facts, "sheet");

      await page.getByTestId("copilot-chat-textarea").fill("and the Monday after that one?");
      await expect(page.getByTestId("copilot-send-button")).toBeEnabled();
      assertTypedComposerStaysContained(await readChatFacts(page, "assistant-sheet"));
    });
  });
}

// ---------------------------------------------------------------------------
// THE OWNERSHIP BOUNDARY
// ---------------------------------------------------------------------------
//
// The scope wrapper encloses the WHOLE panel, not just the chat view: the header, the
// welcome, the refusal and lifecycle notices, the diagnostic card, the proposal Preview
// and the receipts are all app-owned surfaces beneath it. The control overrides were
// first keyed on `button[data-slot="button"]` -- which is not a CopilotKit marker at
// all, because `components/ui/button.tsx` stamps the identical attribute -- so they
// repainted every one of those app-owned controls. The primary proposal Apply became a
// ghost and Revise lost its heavier `--rule` edge, with handlers and authority intact
// and only the meaning gone.
//
// This case pins BOTH sides in one document, which is what makes it a boundary test
// rather than two independent claims: an app-owned primary keeps `--brand`/`--onbrand`
// with no border, and a CopilotKit control in the same transcript keeps the ghost
// treatment. A test that only checked the app side would also pass if the rules had
// been deleted outright.

/** The seed the T07 Preview journey uses, so a prepared proposal has real rows to touch. */
const PROPOSAL_SEED = {
  rangeStart: "2026-04-01",
  rangeEnd: "2026-04-30",
  staff: [
    { id: "Ana", history: [] },
    { id: "Bo", history: [] },
  ],
  shifts: [{ id: "AM" }, { id: "PM" }],
};

/**
 * Prepare and apply a real change, so a real RECEIPT card mounts inside the wrapper.
 *
 * The receipt is the app-owned surface that is reachable without a live model. The
 * Preview itself is not: `useAssistantProposals` renders it from
 * `store.activeProposal`, which only `assistantActions.showProposal` sets, and that is
 * called by the proposal TOOL inside a turn. Exposing it on the test bridge was
 * considered and rejected -- `assistant-test-bridge.test.tsx` pins the bridge to
 * "operations, not setters: there is nothing here that writes a projection directly",
 * and a projection setter is exactly what it would have been. So this drives the real
 * durable path instead and asserts against the surface that path produces; the
 * Preview's own primary treatment is covered by the transplant below, which measures
 * the same cascade at the same DOM position.
 */
async function applyRealChange(page: Page) {
  const outcome = await page.evaluate(async (patch) => {
    const store = (window as unknown as NsWindow).__nsStore;
    await store.commands.mutate(patch);
    await store.drain();
    const proposalId = crypto.randomUUID();
    const prepared = await store.assistantProposal.prepare({
      proposalId,
      threadId: "chat-ui-boundary-thread",
      turnId: "chat-ui-boundary-turn",
      registryStamp: store.capabilityStamp(),
      commands: [
        {
          type: "set_roster_range",
          start: "2026-04-01",
          end: "2026-04-15",
          importPublicHolidays: false,
        },
      ],
      rationale: "Driven by the assistant chat-UI ownership-boundary case.",
      evidence: [],
      outcome: "untested",
    });
    if (!prepared.ok) return { stage: "prepare", ok: false, reason: prepared.reason };
    const applied = await store.assistantProposal.apply({
      proposalId: prepared.proposal?.proposalId ?? proposalId,
      receiptId: crypto.randomUUID(),
    });
    await store.drain();
    return { stage: "apply", ok: applied.ok, reason: applied.reason };
  }, PROPOSAL_SEED);
  // Non-vacuity: without a committed receipt the app-owned card never mounts, and the
  // assertions below would be measuring elements that do not exist.
  expect(outcome, `driving a real change failed at ${outcome.stage}`).toMatchObject({
    stage: "apply",
    ok: true,
  });
}

test("app-owned controls keep their own contract beneath the assistant wrapper", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => {
    (window as unknown as { __NS_ENABLE_TEST_BRIDGE?: boolean }).__NS_ENABLE_TEST_BRIDGE = true;
  });
  await page.setViewportSize(WIDE_VIEWPORT);
  await stubCatalog(page);
  await stubProbe(page);
  // Stays on /settings, which is where the one app-owned PRIMARY button that renders
  // without a live model already is: `ai-test`. The dock docks beside it, so the same
  // document holds an app primary outside the wrapper, app-owned controls inside it,
  // and CopilotKit's own controls inside the chat root.
  await activate(page);
  await seedConversation(page);

  await page.getByTestId("assistant-launcher").click();
  await expect(page.getByTestId("assistant-dock")).toBeVisible();
  await expect(page.getByTestId("copilot-message-list")).toBeVisible();

  await applyRealChange(page);
  await expect(page.getByTestId("receipt-undo")).toBeVisible();

  const facts = await page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>('[data-testid="assistant-dock"]')!;
    const probe = document.createElement("div");
    probe.style.position = "absolute";
    probe.style.visibility = "hidden";
    panel.append(probe);
    const token = (value: string) => {
      probe.style.backgroundColor = "";
      probe.style.backgroundColor = value;
      return getComputedStyle(probe).backgroundColor;
    };
    const tokens = {
      brand: token("var(--brand)"),
      onbrand: token("var(--onbrand)"),
      surface: token("var(--surface)"),
      line: token("var(--line)"),
      rule: token("var(--rule)"),
    };
    probe.remove();

    const paint = (el: Element) => {
      const style = getComputedStyle(el);
      return {
        background: style.backgroundColor,
        color: style.color,
        borderWidth: style.borderTopWidth,
        borderColor: style.borderTopColor,
        borderRadius: style.borderTopLeftRadius,
        // Whether this control is beneath the scope wrapper at all. If an app-owned
        // surface rendered OUTSIDE it, the whole case would pass testing nothing.
        insideWrapper: el.closest("[data-copilotkit]") !== null,
        // And whether it is beneath a CopilotKit-owned root, which is the line the
        // control overrides are now drawn on.
        insideChatRoot:
          el.closest('[data-testid="copilot-chat"]') !== null ||
          el.closest('[data-testid="copilot-message-list"]') !== null,
      };
    };
    const read = (testId: string) => {
      const el = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
      return el ? paint(el) : null;
    };

    // THE CONTROLLED EXPERIMENT, and the reason it is a transplant rather than a
    // hand-written probe: the claim is a pure cascade fact -- "position beneath the
    // wrapper, outside the CopilotKit roots, does not change an app Button's variant
    // paint" -- and the cleanest way to test that is to measure ONE element in both
    // positions. `ai-test` is a real, rendered, app-owned primary `Button`, so its
    // class list comes from `components/ui/button.tsx` rather than from this file;
    // copying the variant string in here would have been a second source of truth that
    // could drift silently. The clone is inserted where the Preview renders: a sibling
    // of the chat view inside `assistant-live-conversation`.
    const source = document.querySelector<HTMLElement>('[data-testid="ai-test"]');
    const host = document.querySelector<HTMLElement>('[data-testid="assistant-live-conversation"]');
    let transplant: ReturnType<typeof paint> | null = null;
    let transplantClassMatches = false;
    if (source && host) {
      const clone = source.cloneNode(true) as HTMLElement;
      clone.setAttribute("data-testid", "boundary-transplant");
      host.prepend(clone);
      transplant = paint(clone);
      transplantClassMatches = clone.className === source.className;
      clone.remove();
    }

    return {
      tokens,
      outsidePrimary: read("ai-test"),
      transplant,
      transplantClassMatches,
      undo: read("receipt-undo"),
      close: read("assistant-close"),
      copy: read("copilot-copy-button"),
      send: read("copilot-send-button"),
    };
  });

  // --- the reference: an app primary OUTSIDE the wrapper ------------------------
  expect(facts.outsidePrimary, "the app primary reference did not render").not.toBe(null);
  expect(facts.outsidePrimary!.insideWrapper).toBe(false);
  expect(facts.outsidePrimary!.background).toBe(facts.tokens.brand);
  expect(facts.outsidePrimary!.color).toBe(facts.tokens.onbrand);
  expect(facts.outsidePrimary!.borderWidth).toBe("0px");

  // --- the same element, transplanted to where the Preview renders --------------
  //
  // This is the assertion the broad selector fails: it measured `--surface` / `--ink`
  // and a 1px `--line` edge here, so the primary proposal Apply rendered as a ghost.
  expect(facts.transplant, "the transplant did not run").not.toBe(null);
  expect(facts.transplantClassMatches, "the clone must carry the source's own classes").toBe(true);
  expect(facts.transplant!.insideWrapper, "the transplant must be beneath the wrapper").toBe(true);
  expect(
    facts.transplant!.insideChatRoot,
    "the transplant must sit where app surfaces sit, outside the CopilotKit roots",
  ).toBe(false);
  // Identical in both positions, and identical to the tokens rather than merely equal
  // to each other -- an equality-only check passes when BOTH placements are broken.
  expect(facts.transplant!.background).toBe(facts.outsidePrimary!.background);
  expect(facts.transplant!.color).toBe(facts.outsidePrimary!.color);
  expect(facts.transplant!.borderWidth).toBe(facts.outsidePrimary!.borderWidth);
  expect(facts.transplant!.background).toBe(facts.tokens.brand);
  expect(facts.transplant!.color).toBe(facts.tokens.onbrand);
  expect(facts.transplant!.borderWidth).toBe("0px");

  // --- a REAL app-owned control inside the wrapper ------------------------------
  //
  // The receipt's Undo is the app's `outline` variant, whose whole distinction from
  // `ghost` is the heavier `--rule` edge. The broad selector replaced it with `--line`,
  // which is why this discriminates where the header's ghost close button cannot: that
  // one's own treatment happens to be byte-identical to what the leak painted.
  expect(facts.undo, "the receipt Undo did not render").not.toBe(null);
  expect(facts.undo!.insideWrapper).toBe(true);
  expect(facts.undo!.insideChatRoot).toBe(false);
  expect(facts.undo!.background).toBe(facts.tokens.surface);
  expect(facts.undo!.borderColor).toBe(facts.tokens.rule);
  expect(facts.close!.insideWrapper).toBe(true);
  expect(facts.close!.insideChatRoot).toBe(false);

  // --- the CopilotKit side, in the same document --------------------------------
  //
  // Without this the case would also pass if the overrides had simply been deleted.
  expect(facts.copy!.insideChatRoot).toBe(true);
  expect(facts.copy!.background).toBe(facts.tokens.surface);
  expect(facts.copy!.borderColor).toBe(facts.tokens.line);
  expect(facts.copy!.borderWidth).toBe("1px");
  expect(facts.send!.insideChatRoot).toBe(true);
  expect(facts.send!.background).toBe(facts.tokens.brand);
  expect(facts.send!.color).toBe(facts.tokens.onbrand);
});

// The coarse-pointer minimum, on the real controls. This spec runs in the `chromium`
// project, which is a precise pointer, so the 44px rule is otherwise never exercised
// here -- and `playwright.config.ts` scopes the `v2-touch` project to one other spec by
// filename. A context of its own is cheaper than widening that project, and it asserts
// the media query matched BEFORE measuring, because a context that silently stayed
// fine-pointer would measure 36/32px and "pass" for exactly the wrong reason.
test("coarse pointers get real 44px targets on the library's own controls", async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({ viewport: NARROW_VIEWPORT, hasTouch: true });
  const page = await context.newPage();
  await page.addInitScript(() => {
    (window as unknown as { __NS_ENABLE_TEST_BRIDGE?: boolean }).__NS_ENABLE_TEST_BRIDGE = true;
  });
  await stubCatalog(page);
  await stubProbe(page);
  await activate(page);
  await gotoReadyShell(page, "/dates");
  await seedConversation(page);

  await page.getByTestId("assistant-launcher").click();
  await expect(page.getByTestId("copilot-message-list")).toBeVisible();

  const facts = await page.evaluate(() => {
    const size = (testId: string) => {
      const el = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
      if (!el) return null;
      const box = el.getBoundingClientRect();
      return { width: box.width, height: box.height };
    };
    return {
      coarse: window.matchMedia("(pointer: coarse)").matches,
      touchPoints: navigator.maxTouchPoints,
      copy: size("copilot-copy-button"),
      send: size("copilot-send-button"),
      attachment: size("copilot-add-menu-button"),
    };
  });

  expect(facts.coarse).toBe(true);
  expect(facts.touchPoints).toBeGreaterThan(0);
  for (const [name, box] of [
    ["copy", facts.copy],
    ["send", facts.send],
    ["attachment", facts.attachment],
  ] as const) {
    expect(box, `${name} did not render`).not.toBe(null);
    expect(box!.width, `${name} width`).toBeGreaterThanOrEqual(44);
    expect(box!.height, `${name} height`).toBeGreaterThanOrEqual(44);
  }
  await context.close();
});

// The two themes must actually RESOLVE DIFFERENTLY. Without this, a broken pre-paint
// script or a stylesheet that ignored `.dark` would let the dark cases above pass by
// measuring light values against light tokens -- every assertion there compares a
// computed value to a token resolved in the same document.
test("the assistant's own surfaces re-resolve per theme", async ({ browser }) => {
  test.setTimeout(180_000);
  // A SEPARATE CONTEXT PER THEME, not two pages in one. The assistant's settings row
  // and its conversation live in IndexedDB for the origin, so a second page in the
  // same context would find AI already enabled and the activation journey would toggle
  // it back OFF -- which is exactly how the first version of this test failed.
  const read = async (theme: "light" | "dark") => {
    const context = await browser.newContext({ viewport: WIDE_VIEWPORT });
    const fresh = await context.newPage();
    await fresh.addInitScript(
      ([selected]) => {
        (window as unknown as { __NS_ENABLE_TEST_BRIDGE?: boolean }).__NS_ENABLE_TEST_BRIDGE = true;
        try {
          window.localStorage.setItem("ns-theme", selected);
        } catch {
          /* ignore */
        }
      },
      [theme] as const,
    );
    await stubCatalog(fresh);
    await stubProbe(fresh);
    await activate(fresh);
    await gotoReadyShell(fresh, "/dates");
    await seedConversation(fresh);
    await fresh.getByTestId("assistant-launcher").click();
    await expect(fresh.getByTestId("copilot-message-list")).toBeVisible();
    await expect(fresh.locator("[data-copilotkit] pre")).toBeAttached();
    const facts = await readChatFacts(fresh, "assistant-dock");
    await context.close();
    return facts;
  };

  const light = await read("light");
  const dark = await read("dark");

  expect(light.theme.darkClass).toBe(false);
  expect(dark.theme.darkClass).toBe(true);
  expect(dark.tokens.surface).not.toBe(light.tokens.surface);
  expect(dark.tokens.ink).not.toBe(light.tokens.ink);
  // And the assistant's own painted surfaces moved with them, rather than staying on
  // the library's fixed near-white/near-black pair.
  expect(dark.composer.background).not.toBe(light.composer.background);
  expect(dark.userBubble.background).not.toBe(light.userBubble.background);
  expect(dark.assistantProse.color).not.toBe(light.assistantProse.color);

  // AND SO DID THE SYNTAX TOKENS. Streamdown ships a dark palette per token and
  // switches to it with a utility only the consuming app's Tailwind can emit, so dark
  // mode silently kept the LIGHT tokens -- a keyword red at 3.55:1 on the dark L1
  // surface. Comparing the two themes is what makes that failure visible; equality
  // here is the bug.
  expect(light.codeBlock.tokenColor).not.toBe("");
  expect(dark.codeBlock.tokenColor).not.toBe(light.codeBlock.tokenColor);
});
