// @vitest-environment jsdom
//
// R6 — the Optimize & Export route's v2 visual-role contract, asserted at the
// component boundary.
//
// What this file is FOR, and what it deliberately is not. F4's browser matrix and
// `e2e/optimize-visual.spec.ts` prove the RESOLVED paint for all four R6 rows in a
// real Chromium. Neither can prove which CONTRACT produced that paint: a
// hand-authored `bg-panel shadow-well` and the shared `well` role compute
// identically, and the whole point of the re-skin is that this screen stops forking
// its own presentation. So these tests pin the AUTHORITY — the surface recipe's
// roles, the shared primitives' slots, and the status tint↔ink pairings — and are
// discriminating exactly where a regression would be invisible downstream:
// reverting a role to a literal utility, re-pairing a status tint with neutral ink,
// or reintroducing one of the retired v1 type/emphasis utilities fails here while
// every pixel still looks plausible.
//
// `OptimizeAndExportScreen` itself is not rendered here (it needs the durable store
// and the router); its page-plane root and its two route cards are pinned against
// resolved computed styles in `e2e/optimize-visual.spec.ts` instead.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { surfaceVariants } from "@/components/ui/surface";
import {
  formatScore,
  INITIAL_OPTIMIZE_RUN_VIEW,
  reduceRunView,
  type OptimizeRunView,
  type OptimizeServerInfo,
  type RunLogEntry,
  type RunLogKind,
  type RunSignal,
} from "@/lib/optimize";
import { Callout, type CalloutTone } from "./callout";
import { ReadinessBanner } from "./readiness-banner";
import { RecoveryNotice } from "./recovery-notice";
import { RunEventLog } from "./run-event-log";
import { RunOptionsForm } from "./run-options-form";
import { RunStatusPanel } from "./run-status-panel";
import { ServerIdentity } from "./server-identity";
import { ProgressChart } from "./progress-chart";

// GuardedLink (the readiness links and the infeasible "Adjust rules" CTA) reads the
// Next router; the same lightweight stub the sibling render tests use.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/optimize-and-export",
}));

afterEach(() => {
  cleanup();
});

const noop = () => {};

/** Every class the named recipe role emits, so a test never restates a token. */
function roleClasses(...args: Parameters<typeof surfaceVariants>): string[] {
  return surfaceVariants(...args)
    .split(/\s+/)
    .filter(Boolean);
}

// `classList`, not `className` — an SVGElement's `className` is an
// `SVGAnimatedString`, and this file walks SVG geometry as well as HTML.
function classesOf(element: Element): string[] {
  return Array.from(element.classList);
}

/**
 * A DATA-BEARING value takes the mono face and nothing else changes.
 *
 * Both halves matter. Asserting only `font-mono` would stay green if the value
 * ALSO kept the display face (tailwind-merge resolves the pair, so the rendered
 * class list would still look right while the authored contract had two faces in
 * it); asserting only the absence of `font-heading` would stay green for a value
 * left on the inherited body face, which is the exact defect being closed.
 */
function expectMonoData(element: Element, label: string) {
  const classes = classesOf(element);
  expect(classes, `${label} → mono data face`).toContain("font-mono");
  expect(classes, `${label} → not the display face`).not.toContain("font-heading");
}

function expectRole(element: Element, ...args: Parameters<typeof surfaceVariants>) {
  const classes = classesOf(element);
  for (const token of roleClasses(...args)) {
    expect(
      classes,
      `${element.getAttribute("data-testid") ?? element.tagName} → ${token}`,
    ).toContain(token);
  }
}

// The v1 utilities this ticket retired across the whole Optimize surface. Each was
// either the retired type doctrine (Figtree 800 / -0.02em-ish `tracking-tight`) or
// an arbitrary alpha standing in for a token. ANY of them reappearing in a rendered
// R6 tree means the screen has drifted back off the v2 contract.
const RETIRED_V1_CLASSES = [
  "font-extrabold",
  "tracking-tight",
  "bg-panel/40",
  "bg-panel/70",
  "border-brand/40",
  "ring-brand/40",
  "ring-brand",
];

function expectNoRetiredV1(container: HTMLElement) {
  const offenders: string[] = [];
  for (const el of Array.from(container.querySelectorAll<HTMLElement>("*"))) {
    for (const token of classesOf(el)) {
      if (RETIRED_V1_CLASSES.includes(token))
        offenders.push(`${el.tagName.toLowerCase()}.${token}`);
    }
  }
  expect(offenders).toEqual([]);
}

function view(over: Partial<OptimizeRunView>): OptimizeRunView {
  return { ...INITIAL_OPTIMIZE_RUN_VIEW, ...over };
}

const STATUS_HANDLERS = {
  onCancel: noop,
  onFinishNow: noop,
  onResubmit: noop,
  onDismiss: noop,
  onDownloadArtifact: noop,
  onDownloadAgain: noop,
  onRetryCleanup: noop,
  onAbandonCleanup: noop,
};

function renderStatus(over: Partial<OptimizeRunView>, cleanupPhase: "idle" | "failed" = "idle") {
  return render(
    <RunStatusPanel
      view={view(over)}
      submitting={false}
      cleanupPhase={cleanupPhase}
      canDownloadAgain={false}
      downloadAgainFilename={null}
      {...STATUS_HANDLERS}
    />,
  );
}

function renderOptions(over: Partial<React.ComponentProps<typeof RunOptionsForm>> = {}) {
  return render(
    <RunOptionsForm
      stats={{ nurses: 12, days: 28, shifts: 3, rulesOn: 5 }}
      prettify
      anonymize
      timeout="300"
      timeoutError={null}
      optionsDisabled={false}
      submitEnabled
      submitting={false}
      disabledReason={null}
      onPrettifyChange={noop}
      onAnonymizeChange={noop}
      onTimeoutChange={noop}
      onSubmit={noop}
      {...over}
    />,
  );
}

const SERVER_INFO: OptimizeServerInfo = {
  status: "online",
  apiVersion: "alpha",
  backendVersion: "1.0.0",
  clientVersion: "1.0.0",
  versionTier: "identical",
  unavailableReason: null,
  recheck: noop,
};

const logEntry = (seq: number, kind: RunLogKind): RunLogEntry => ({
  seq,
  kind,
  label: kind,
  event: null,
  cursor: null,
  payload: null,
  detail: null,
  detailKind: null,
  elapsedSeconds: null,
  occurredAt: null,
  eventTime: 1_700_000_000_000,
});

// ---------------------------------------------------------------------------
// Callout — the route's status primitive
// ---------------------------------------------------------------------------

describe("Callout carries the v2 status pairings and the inset-island geometry", () => {
  // The Redundant Signal Rule: a tint pairs with its OWN semantic ink, on the
  // title AND the body. v1 painted every status tint with neutral --ink/--ink2,
  // which is a different colour from the tint's ink tier in dark mode.
  const PAIRS: Array<{ tone: CalloutTone; tint: string; ink: string; base: string }> = [
    { tone: "warn", tint: "bg-warntint", ink: "text-warnink", base: "text-warn" },
    { tone: "error", tint: "bg-errortint", ink: "text-errorink", base: "text-error" },
    { tone: "success", tint: "bg-successtint", ink: "text-successink", base: "text-success" },
  ];

  it.each(PAIRS)("$tone pairs its tint with the matching ink", ({ tone, tint, ink, base }) => {
    render(
      <Callout tone={tone} title="Title" data-testid="probe">
        Body
      </Callout>,
    );
    const root = screen.getByTestId("probe");
    expect(classesOf(root)).toContain(tint);
    // §5: an inset island rounds to --r-ctl; it is not a full-bleed band.
    expect(classesOf(root)).toContain("rounded-control");

    for (const slot of ["callout-title", "callout-body"]) {
      const el = root.querySelector(`[data-slot="${slot}"]`);
      expect(el, slot).not.toBeNull();
      expect(classesOf(el!), slot).toContain(ink);
      // Neither the neutral ink nor the BASE tier may carry the text.
      expect(classesOf(el!), slot).not.toContain("text-ink");
      expect(classesOf(el!), slot).not.toContain("text-ink2");
      expect(classesOf(el!), slot).not.toContain(base);
    }

    // The leading icon keeps the base tier — §2's "icon on its own tint".
    const icon = root.querySelector("svg");
    expect(icon).not.toBeNull();
    expect(classesOf(icon!)).toContain(base);
  });

  it("the neutral info tone is the canonical well, not a bordered --line box", () => {
    render(
      <Callout tone="info" title="Title" data-testid="probe">
        Body
      </Callout>,
    );
    const classes = classesOf(screen.getByTestId("probe"));
    expect(classes).toContain("bg-panel");
    // Direction of light is fixed (§4 rule 1): a well takes the INSET cast.
    expect(classes).toContain("shadow-well");
    expect(classes).toContain("border-line2");
    expect(classes).toContain("rounded-control");
    // v1's primary-border box is retired for this role.
    expect(classes).not.toContain("border-line");
  });
});

// ---------------------------------------------------------------------------
// Ladder placement — what a callout may be, given where it is mounted
// ---------------------------------------------------------------------------
//
// DESIGN.md §4 puts nothing free-floating on L0 and seats a well "*inside* an L1
// card". A neutral `--panel` callout rendered straight onto the page plane is
// therefore recessed into nothing — the defect the Round 8 review found on the
// resumed and storage-unavailable recovery notices. `placement` names the mount
// point, and the neutral tone answers it by moving to the L1 role.

describe("Callout placement seats the neutral tone on a real rung of the ladder", () => {
  function renderCallout(props: Partial<React.ComponentProps<typeof Callout>> = {}) {
    cleanup();
    render(
      <Callout title="Title" data-testid="probe" {...props}>
        Body
      </Callout>,
    );
    return screen.getByTestId("probe");
  }

  it("a PAGE-placed neutral notice is the shared L1 surface role", () => {
    const root = renderCallout({ tone: "info", placement: "page" });
    // Asserted against the recipe the rest of the route's top-level containers
    // use, not a copied token list: if the L1 role is ever re-specified, this
    // fails rather than pinning a stale spelling.
    expectRole(root, { role: "surface", geometry: "card" });
    expect(root.getAttribute("data-placement")).toBe("page");

    // And it is emphatically NOT the well it used to be. Each token is named so
    // a partial revert (right tone, dropped shadow) still fails.
    const classes = classesOf(root);
    for (const retired of ["bg-panel", "shadow-well", "border-line2", "rounded-control"]) {
      expect(classes, `page placement must not keep ${retired}`).not.toContain(retired);
    }
  });

  it("the neutral well survives unchanged at INSET placement", () => {
    const root = renderCallout({ tone: "info" });
    const classes = classesOf(root);
    // Nested inside an L1 card the well is correct and must not be collateral
    // damage of the page fix — the version note, the cleanup notices and the
    // download states all still render this form.
    for (const token of ["bg-panel", "shadow-well", "border-line2", "rounded-control"]) {
      expect(classes, `inset placement keeps ${token}`).toContain(token);
    }
    expect(classes, "an inset island is not L1").not.toContain("bg-surface");
    expect(root.getAttribute("data-placement")).toBe("inset");
  });

  it("an unplaced callout defaults to the inset island", () => {
    expect(renderCallout({ tone: "info" }).className).toBe(
      renderCallout({ tone: "info", placement: "inset" }).className,
    );
  });

  // The tinted tones already carry a tint plus a matching semantic border, which
  // is a self-contained banner at either placement AND the treatment the
  // prototype itself authors for a page-level notice. Placement must therefore
  // be a no-op for them — a page fix that also restyled every warning would be a
  // far wider change than the ladder defect called for.
  it.each(["warn", "error", "success"] as const)(
    "%s renders identically at both placements",
    (tone) => {
      const inset = renderCallout({ tone }).className;
      const page = renderCallout({ tone, placement: "page" }).className;
      expect(page).toBe(inset);
    },
  );
});

// ---------------------------------------------------------------------------
// Readiness banner
// ---------------------------------------------------------------------------

describe("ReadinessBanner", () => {
  it("gives its inline links the D10 coarse-pointer height floor", () => {
    render(
      <ReadinessBanner
        issues={[
          {
            kind: "dates",
            before: "Set a range on the ",
            href: "/dates",
            linkLabel: "Dates",
            after: " screen.",
          },
        ]}
      />,
    );
    const link = screen.getByRole("link", { name: "Dates" });
    const classes = classesOf(link);
    // An inline <a> is measured height-only by F4's target battery, and a bare
    // inline box cannot carry a min-height at all — hence inline-flex.
    expect(classes).toContain("inline-flex");
    expect(classes).toContain("pointer-coarse:min-h-touch");
  });
});

// ---------------------------------------------------------------------------
// Recovery notices — the route's only page-plane callouts
// ---------------------------------------------------------------------------

describe("RecoveryNotice declares the page plane it is actually mounted on", () => {
  type RecoveryProps = React.ComponentProps<typeof RecoveryNotice>;

  const BASE: RecoveryProps = {
    state: { kind: "none" },
    resume: null,
    reloadRecoveryUnavailable: false,
    onForget: noop,
    forgetPending: false,
  };

  const RESUMABLE = {
    kind: "resumable",
    jobId: "opt_1",
    anonymized: false,
    peopleCount: 2,
  } as const;

  // Every notice this component can render, with the tone it is authored at.
  // Enumerated rather than sampled: the defect was in two states, but the
  // placement declaration is a property of the component's MOUNT POINT, so a
  // notice added later without it is the same bug returning.
  const NOTICES: Array<{ testId: string; tone: string; over: Partial<RecoveryProps> }> = [
    { testId: "optimize-degraded", tone: "warn", over: { reloadRecoveryUnavailable: true } },
    {
      testId: "optimize-resumed",
      tone: "info",
      over: { state: RESUMABLE, resume: { status: "attached", jobId: "opt_1" } },
    },
    {
      testId: "optimize-resume-failed",
      tone: "error",
      over: { state: RESUMABLE, resume: { status: "conflict", reason: "already attached" } },
    },
    {
      testId: "optimize-interrupted",
      tone: "warn",
      over: { state: { kind: "interrupted", anonymized: true, peopleCount: 3 } },
    },
    { testId: "optimize-unreadable", tone: "warn", over: { state: { kind: "unreadable" } } },
    { testId: "optimize-storage-error", tone: "info", over: { state: { kind: "storage-error" } } },
  ];

  it.each(NOTICES)("$testId is declared at page placement", ({ testId, tone, over }) => {
    render(<RecoveryNotice {...BASE} {...over} />);
    const notice = screen.getByTestId(testId);
    expect(notice.getAttribute("data-tone"), testId).toBe(tone);
    expect(notice.getAttribute("data-placement"), testId).toBe("page");
  });

  // The two the review actually faulted: a `--panel` well with an inset cast,
  // rendered directly onto the L0 route root.
  it.each(NOTICES.filter((n) => n.tone === "info"))(
    "$testId resolves the L1 page treatment instead of an unhosted well",
    ({ testId, over }) => {
      render(<RecoveryNotice {...BASE} {...over} />);
      const notice = screen.getByTestId(testId);
      expectRole(notice, { role: "surface", geometry: "card" });
      expect(classesOf(notice), "a well needs a host plane").not.toContain("shadow-well");
      expect(classesOf(notice), "a well needs a host plane").not.toContain("bg-panel");
    },
  );

  // No nested L1: the notices are siblings of the route cards, and each renders
  // exactly one container — the component adds no wrapper of its own.
  it("adds no container around the notices it renders", () => {
    const { container } = render(
      <RecoveryNotice {...BASE} state={{ kind: "storage-error" }} reloadRecoveryUnavailable />,
    );
    const roots = Array.from(container.children);
    expect(roots.map((el) => el.getAttribute("data-testid"))).toEqual([
      "optimize-degraded",
      "optimize-storage-error",
    ]);
    for (const root of roots) {
      expect(root.getAttribute("data-slot"), "each notice IS the callout").toBe("callout");
    }
  });
});

// ---------------------------------------------------------------------------
// Run options form
// ---------------------------------------------------------------------------

describe("RunOptionsForm", () => {
  it("keeps the stat grid square and sets its numerals in the mono data face", () => {
    const { container } = renderOptions();
    const grid = screen.getByTestId("optimize-scenario-stats");
    // A data structure is never rounded (§5). No radius utility of any role.
    expect(classesOf(grid).filter((c) => c.startsWith("rounded-"))).toEqual([]);

    // DESIGN.md §3 reserves the mono face for "IDs, counts, hours and solver
    // expressions", and D8 puts that explicit rule above the prototype's
    // display-face example. Every one of the four cells is asserted, not just the
    // first, and the heading face is REJECTED so the retired interpretation cannot
    // come back while the weight/tracking still look right.
    for (const testId of [
      "optimize-stat-nurses",
      "optimize-stat-days",
      "optimize-stat-shifts",
      "optimize-stat-rules-on",
    ]) {
      const numeral = screen.getByTestId(testId).firstElementChild;
      expect(numeral, testId).not.toBeNull();
      const classes = classesOf(numeral!);
      expect(classes, `${testId} → mono data face`).toContain("font-mono");
      expect(classes, `${testId} → not the display face`).not.toContain("font-heading");
      expect(classes, `${testId} → ratified v2 Title weight`).toContain("font-semibold");
      expect(classes, `${testId} → ratified tracking`).toContain("tracking-[-0.015em]");
    }

    expectNoRetiredV1(container);
  });

  it("puts validation and gating copy on the semantic INK tier", () => {
    renderOptions({ timeoutError: "Solver timeout must be a valid positive integer." });
    expect(classesOf(screen.getByRole("alert"))).toContain("text-errorink");

    cleanup();
    renderOptions({ submitEnabled: false, disabledReason: "Backend unavailable." });
    const reason = screen.getByTestId("optimize-disabled-reason");
    expect(classesOf(reason)).toContain("text-warnink");
    expect(classesOf(reason)).not.toContain("text-warn");
  });

  it("routes its submit action through the shared Button, not a local control", () => {
    renderOptions();
    expect(screen.getByTestId("optimize-submit")).toHaveAttribute("data-slot", "button");
  });
});

// ---------------------------------------------------------------------------
// Server identity
// ---------------------------------------------------------------------------

describe("ServerIdentity", () => {
  it("sets the version line in the mono face and keeps its controls shared", () => {
    const { container } = render(<ServerIdentity info={SERVER_INFO} />);
    const line = screen.getByText(/API version:/);
    expect(classesOf(line)).toContain("font-mono");
    expect(screen.getByTestId("optimize-recheck")).toHaveAttribute("data-slot", "button");
    expectNoRetiredV1(container);
  });
});

// ---------------------------------------------------------------------------
// Run status panel
// ---------------------------------------------------------------------------

describe("RunStatusPanel", () => {
  const TERMINALS: Array<{ label: string; over: Partial<OptimizeRunView>; ink: string }> = [
    {
      label: "completed/optimal",
      ink: "text-successink",
      over: {
        lifecycle: "completed",
        jobId: "opt_1",
        result: {
          outcome: "optimal",
          score: 42,
          solverStatus: "OPTIMAL",
          terminationReason: "optimality_proven",
        },
        download: { status: "downloaded", artifactAvailable: true, filename: "schedule.xlsx" },
      },
    },
    {
      label: "cancelled",
      ink: "text-warnink",
      over: {
        lifecycle: "cancelled",
        jobId: "opt_1",
        error: { source: "job", code: "cancelled", message: "Run cancelled." },
      },
    },
  ];

  it.each(TERMINALS)(
    "$label — the terminal eyebrow uses the ink tier and drops the leader dot",
    ({ over, ink }) => {
      renderStatus(over);
      const eyebrow = screen.getByTestId("optimize-terminal-eyebrow");
      expect(classesOf(eyebrow)).toContain(ink);
      // §5 retires decorative ornament on status: no leader dot, no check glyph.
      expect(eyebrow.textContent ?? "").not.toContain("●");
    },
  );

  it("idle — the placeholder tile is dashed and the heading is the v2 Title weight", () => {
    const { container } = renderStatus({});
    const tile = screen.getByTestId("optimize-idle").firstElementChild;
    expect(tile).not.toBeNull();
    expect(classesOf(tile!)).toContain("border-dashed");

    const heading = screen.getByRole("heading", { name: "Ready to optimise" });
    expect(classesOf(heading)).toContain("font-semibold");
    expect(classesOf(heading)).toContain("tracking-[-0.015em]");
    expectNoRetiredV1(container);
  });

  it("infeasible — the solver verdict strip is a well, not a flat --panel box", () => {
    render(
      <RunStatusPanel
        view={view({
          lifecycle: "completed",
          jobId: "opt_1",
          result: {
            outcome: "infeasible",
            score: null,
            solverStatus: "INFEASIBLE",
            terminationReason: "infeasibility_proven",
          },
          download: { status: "unavailable", artifactAvailable: false, filename: null },
        })}
        submitting={false}
        cleanupPhase="idle"
        canDownloadAgain={false}
        downloadAgainFilename={null}
        {...STATUS_HANDLERS}
      />,
    );
    const strip = screen.getByText(/^verdict:/);
    const classes = classesOf(strip);
    expect(classes).toContain("bg-panel");
    expect(classes).toContain("shadow-well");
    expect(classes).toContain("rounded-control");
  });

  it("keeps the terminal summary grid square inside its rounded card", () => {
    renderStatus(TERMINALS[0].over);
    const grid = screen.getByTestId("optimize-summary-grid");
    expect(classesOf(grid).filter((c) => c.startsWith("rounded-"))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The mono data face across the whole route (DESIGN.md §3 / D8)
// ---------------------------------------------------------------------------
//
// §3 reserves Spline Sans Mono for "IDs, counts, hours and solver expressions —
// so a number always reads as data, never as prose in the wrong face", and D8
// puts that explicit rule above the prototype's display-face example. Each test
// binds ONE target by its own testid and asserts the face changed while size,
// weight, tracking and ink did not — a value quietly restyled instead of
// re-faced fails here.

describe("every data-bearing value on the Optimize route is set in the mono face", () => {
  const ACTIVE: Partial<OptimizeRunView> = {
    lifecycle: "running",
    jobId: "opt_1",
    latestScore: 4212.5,
    controls: { cancellable: true, earlyCompletionAvailable: true },
  };

  const TERMINAL: Partial<OptimizeRunView> = {
    lifecycle: "completed",
    jobId: "opt_1",
    startedAt: "2026-07-20T00:00:01+00:00",
    finishedAt: "2026-07-20T00:01:00+00:00",
    result: {
      outcome: "optimal",
      score: 42,
      solverStatus: "OPTIMAL",
      terminationReason: "optimality_proven",
    },
    download: { status: "downloaded", artifactAvailable: true, filename: "schedule.xlsx" },
  };

  it("the live incumbent score is mono, at the unchanged Display step", () => {
    renderStatus(ACTIVE);
    const score = screen.getByTestId("optimize-score");
    // Through the product's own formatter, so the premise guard does not depend
    // on the runner's locale.
    expect(score.textContent).toBe(formatScore(4212.5));
    expectMonoData(score, "live score");
    // Size, weight, leading, tracking and ink are all retained.
    for (const token of [
      "text-display",
      "font-bold",
      "leading-none",
      "tracking-[-0.015em]",
      "text-ink",
    ]) {
      expect(classesOf(score), `live score → ${token}`).toContain(token);
    }
  });

  // The SAME element renders the "No incumbent yet" sentence before the first
  // feasible solution. That is prose, not data, so it must NOT be mono — and this
  // is the case a blanket `font-mono` on the element would silently break.
  it("the pre-incumbent PROSE placeholder stays on the display face", () => {
    renderStatus({ lifecycle: "running", jobId: "opt_1", latestScore: null });
    const score = screen.getByTestId("optimize-score");
    expect(score.textContent).toBe("No incumbent yet");
    const classes = classesOf(score);
    expect(classes, "a sentence is not data").not.toContain("font-mono");
    expect(classes).toContain("font-heading");
  });

  const SUMMARY: Array<{ testId: string; text: string; label: string }> = [
    { testId: "optimize-summary-solver-status", text: "OPTIMAL", label: "solver status" },
    { testId: "optimize-summary-final-score", text: formatScore(42), label: "final score" },
    { testId: "optimize-summary-elapsed", text: "59s", label: "elapsed" },
  ];

  it.each(SUMMARY)("the terminal summary $label value is mono", ({ testId, text, label }) => {
    renderStatus(TERMINAL);
    const cell = screen.getByTestId(testId);
    // Premise guard: a testid that stopped naming the real value would otherwise
    // let the face assertion pass against an empty element.
    expect(cell.textContent, label).toBe(text);
    expectMonoData(cell, label);
    expect(classesOf(cell), `${label} → ratified v2 Title weight`).toContain("font-semibold");
    expect(classesOf(cell), `${label} → ratified tracking`).toContain("tracking-[-0.015em]");
  });

  it("the summary caption beside each value stays a PROSE label", () => {
    renderStatus(TERMINAL);
    for (const { testId, label } of SUMMARY) {
      const caption = screen.getByTestId(testId).nextElementSibling;
      expect(caption, label).not.toBeNull();
      expect(classesOf(caption!), `${label} caption is not data`).not.toContain("font-mono");
    }
  });

  it("the solver status keeps its semantic ink tier while changing face", () => {
    renderStatus(TERMINAL);
    expect(classesOf(screen.getByTestId("optimize-summary-solver-status"))).toContain(
      "text-successink",
    );
  });

  it("the event count is mono and the noun beside it is not", () => {
    render(<RunEventLog active log={[logEntry(1, "progress"), logEntry(2, "phase")]} />);
    const count = screen.getByTestId("optimize-event-count");
    expect(count.textContent).toBe("2");
    expectMonoData(count, "event count");
    // The uppercase label line still reads "2 events", and the noun is prose.
    const line = count.parentElement!;
    expect(line.textContent).toBe("2 events");
    expect(classesOf(line), "the label line is not itself data").not.toContain("font-mono");
    for (const token of ["text-label", "font-semibold", "uppercase", "text-ink3"]) {
      expect(classesOf(line), `event count line → ${token}`).toContain(token);
    }
  });

  it("each log row's wall-clock time is mono", () => {
    render(<RunEventLog active log={[logEntry(1, "progress")]} />);
    const time = screen.getByTestId("optimize-event-time");
    expect(time.textContent, "a real formatted time, not an empty slot").toMatch(/\d/);
    expectMonoData(time, "event time");
  });

  const TOOLTIP: Array<{ testId: string; label: string }> = [
    { testId: "progress-chart-tooltip-elapsed", label: "elapsed" },
    { testId: "progress-chart-tooltip-score", label: "score" },
    { testId: "progress-chart-tooltip-comments", label: "comments" },
    { testId: "progress-chart-tooltip-solution", label: "solution index" },
  ];

  it("every value in the chart tooltip is mono", () => {
    render(<ProgressChart points={POINTS_FOR_SWEEP} />);
    // The tooltip renders only while a point is inspected; drive the keyboard
    // inspector rather than a pointer, so this binds the real surface.
    fireEvent.focus(screen.getByRole("group", { name: /Progress data points/ }));
    // Scoped to the tooltip: the panel legend carries its own "Score"/"Comments"
    // spans, so an unscoped query would be ambiguous once the tooltip is open.
    const tooltip = within(screen.getByTestId("progress-chart-tooltip"));
    for (const { testId, label } of TOOLTIP) {
      const value = tooltip.getByTestId(testId);
      expect(value.textContent, `${label} renders a value`).not.toBe("");
      expectMonoData(value, `tooltip ${label}`);
    }
    // The dt captions beside them are prose and stay on the body face.
    for (const caption of ["Score", "Comments", "Solution"]) {
      const dt = tooltip.getByText(caption, { selector: "span" }).closest("dt")!;
      expect(classesOf(dt), `${caption} caption is not data`).not.toContain("font-mono");
    }
  });

  // THE SOLVER SOURCE of an inspected point — `ortools/cp-sat:solution-callback`. §3
  // names "solver expressions" explicitly, and this is one: a machine identifier the
  // backend emits, never prose. It was the last value on this route still on the body
  // face while the round claimed whole-route coverage.
  it("the tooltip's solver source is mono", () => {
    render(<ProgressChart points={POINTS_WITH_SOLVER_SOURCE} />);
    fireEvent.focus(screen.getByRole("group", { name: /Progress data points/ }));
    const source = within(screen.getByTestId("progress-chart-tooltip")).getByTestId(
      "progress-chart-tooltip-source",
    );
    expect(source.textContent, "the real solver source, not an empty slot").toBe(
      "ortools/cp-sat:solution-callback",
    );
    expectMonoData(source, "tooltip solver source");
    // Size and ink tier are unchanged — only the face was selected.
    for (const token of ["text-label", "text-ink3"]) {
      expect(classesOf(source), `tooltip source → ${token}`).toContain(token);
    }
  });

  // THE LOG DETAIL, both halves, against values the REDUCER minted rather than kinds
  // this test invented. `MINTED_DETAILS` is read inside the callback on purpose — it is
  // declared further down the file, so touching it at collection time would hit its TDZ.
  it("every log detail takes the face the product minted it for", () => {
    const log = MINTED_DETAILS.map(({ signal }, index) => mintedEntry(signal, index + 1));

    // The reducer really produced these values and kinds; the faces below are not being
    // checked against a fixture this test made up.
    expect(log.map((entry) => entry.detail)).toEqual(MINTED_DETAILS.map((c) => c.detail));
    expect(log.map((entry) => entry.detailKind)).toEqual(MINTED_DETAILS.map((c) => c.kind));

    render(<RunEventLog active log={log} />);
    const rendered = screen.getAllByTestId("optimize-event-detail");
    expect(rendered).toHaveLength(MINTED_DETAILS.length);
    for (const [index, element] of rendered.entries()) {
      const { label, detail, kind } = MINTED_DETAILS[index];
      expect(element.textContent, `${label} renders its real value`).toBe(detail);
      if (kind === "expression") {
        expectMonoData(element, `log detail — ${label}`);
      } else {
        expect(classesOf(element), `${label} is a sentence, not data`).not.toContain("font-mono");
      }
      // Size and ink are unchanged either way — only the face is selected.
      expect(classesOf(element), `${label} keeps its size`).toContain("text-meta");
      expect(classesOf(element), `${label} keeps its ink tier`).toContain("text-ink2");
    }
  });
});

// ---------------------------------------------------------------------------
// Event log
// ---------------------------------------------------------------------------

// Every case below is MINTED BY THE REDUCER: both the detail text and its kind come
// from `run-view.ts`, so these cannot pass by feeding the component a hand-made kind
// the product would never produce. §3 reserves the mono face for codes, ids, counts and
// solver expressions — the wire lane's `state=`, `queue=`, `early_completion=`,
// `outcome=`, `score=` forms, error codes, opaque cursors and artifact filenames —
// while a phase line carrying a backend message, and a transport-error message, are
// prose and must stay on the body face.
interface MintedDetailCase {
  label: string;
  signal: RunSignal;
  detail: string;
  kind: "expression" | "prose";
}

const MINTED_DETAILS: MintedDetailCase[] = [
  {
    label: "the submit key/value summary",
    signal: { type: "submit-started", anonymized: true, peopleCount: 5 },
    detail: "anonymized=true, people=5",
    kind: "expression",
  },
  {
    label: "a wire state and queue position",
    signal: {
      type: "durable-frame-applied",
      event: "job.state_changed",
      cursor: "cur_1",
      detail: "state=running, queue=2",
      payload: {
        kind: "state",
        state: "running",
        terminal: false,
        queuePosition: 2,
        cancelRequested: false,
        earlyCompletionRequested: false,
        cancellable: true,
        earlyCompletionAvailable: false,
        error: null,
      },
    },
    detail: "state=running, queue=2",
    kind: "expression",
  },
  {
    label: "a wire control flag",
    signal: {
      type: "durable-frame-applied",
      event: "job.control_changed",
      cursor: "cur_2",
      detail: "early_completion=true",
      payload: { kind: "control", earlyCompletionRequested: true },
    },
    detail: "early_completion=true",
    kind: "expression",
  },
  {
    label: "a wire result outcome and score",
    signal: {
      type: "durable-frame-applied",
      event: "job.result_available",
      cursor: "cur_3",
      detail: "outcome=optimal, score=42",
      payload: {
        kind: "result",
        outcome: "optimal",
        score: 42,
        solverStatus: "OPTIMAL",
        terminationReason: null,
        artifactName: null,
      },
    },
    detail: "outcome=optimal, score=42",
    kind: "expression",
  },
  {
    label: "the progress counts",
    signal: {
      type: "progress",
      point: {
        source: "ortools/cp-sat:solution-callback",
        currentBestScore: 42,
        elapsedSeconds: 3.5,
        solutionIndex: 7,
        commentCount: 2,
      },
    },
    detail: "score=42, elapsed=3.5s, solution=#7, comments=2",
    kind: "expression",
  },
  {
    label: "an error code",
    signal: { type: "job-gone", code: "job_not_found", message: "gone" },
    detail: "job_not_found",
    kind: "expression",
  },
  {
    label: "an opaque cursor",
    signal: { type: "cursor-recovery", reason: "expired", oldestEventId: "cur_99" },
    detail: "cur_99",
    kind: "expression",
  },
  {
    label: "an artifact filename",
    signal: { type: "download-succeeded", filename: "schedule.xlsx" },
    detail: "schedule.xlsx",
    kind: "expression",
  },
  {
    label: "a phase line carrying a backend message",
    signal: {
      type: "phase",
      entry: { source: "scheduler", code: "solve", message: "Solving", elapsedSeconds: 1.2 },
    },
    detail: "solve: Solving",
    kind: "prose",
  },
  {
    label: "a transport disconnect message",
    signal: { type: "stream-error", message: "Connection lost after 3 attempts." },
    detail: "Connection lost after 3 attempts.",
    kind: "prose",
  },
];

/** Mint one entry through the real reducer, keeping its real detail and kind. */
function mintedEntry(signal: RunSignal, seq: number): RunLogEntry {
  const view = reduceRunView(INITIAL_OPTIMIZE_RUN_VIEW, signal);
  return { ...view.log[view.log.length - 1], seq };
}

describe("RunEventLog", () => {
  it("is an L1 card that clips its own scroll region", () => {
    render(<RunEventLog active log={[logEntry(1, "lifecycle")]} />);
    const root = screen.getByTestId("optimize-event-log");
    expectRole(root, { role: "surface", geometry: "card" });
    // §4 rule 3 — a scroll region that ends a card clips to the card's radius.
    expect(classesOf(root)).toContain("overflow-hidden");
  });

  // The v1 badges were local class lists that painted status tints with a NEUTRAL
  // --ink and drew a `border-brand/40` arbitrary alpha. Routing through the shared
  // Badge fixes the pairing for every kind at once, so the contract worth pinning
  // is the kind → variant mapping and the fact that it IS the shared primitive.
  const KINDS: Array<{ kind: RunLogKind; variant: string }> = [
    { kind: "lifecycle", variant: "neutral" },
    { kind: "state", variant: "neutral" },
    { kind: "control", variant: "neutral" },
    { kind: "result", variant: "success" },
    { kind: "progress", variant: "brand" },
    { kind: "phase", variant: "warn" },
    { kind: "recovery", variant: "brand" },
    { kind: "terminal", variant: "warn" },
    { kind: "error", variant: "error" },
  ];

  it("maps every log kind onto a shared Badge variant", () => {
    const { container } = render(
      <RunEventLog active log={KINDS.map((k, i) => logEntry(i + 1, k.kind))} />,
    );
    for (const { kind, variant } of KINDS) {
      const badge = container.querySelector(`[data-kind="${kind}"]`);
      expect(badge, kind).not.toBeNull();
      expect(badge!.getAttribute("data-slot"), kind).toBe("badge");
      expect(badge!.getAttribute("data-variant"), kind).toBe(variant);
    }
    expectNoRetiredV1(container);
  });
});

// ---------------------------------------------------------------------------
// Progress chart
// ---------------------------------------------------------------------------

describe("ProgressChart", () => {
  const POINTS = [
    { source: "solver", currentBestScore: 8, elapsedSeconds: 2, solutionIndex: 1, commentCount: 0 },
    {
      source: "solver",
      currentBestScore: 12,
      elapsedSeconds: 5,
      solutionIndex: 2,
      commentCount: 1,
    },
  ];

  it("is the nested WELL, never a second L1 card", () => {
    render(<ProgressChart points={POINTS} />);
    const figure = screen.getByTestId("progress-chart");
    expectRole(figure, { role: "well", geometry: "control", emphasis: "hairline" });
    // The retired treatment: an L1 card nested inside an L1 card (§4 rule 5).
    expect(classesOf(figure)).not.toContain("bg-surface");
  });

  it("routes every chart control through the shared Button", () => {
    render(<ProgressChart points={POINTS} />);
    const buttons = Array.from(
      screen.getByTestId("progress-chart").querySelectorAll<HTMLElement>("button"),
    );
    // The comments toggle + five range presets.
    expect(buttons).toHaveLength(6);
    for (const button of buttons) {
      expect(button.getAttribute("data-slot"), button.textContent ?? "").toBe("button");
    }
  });

  it("declares fill=none on every plot so no SVG geometry inherits UA black", () => {
    render(<ProgressChart points={POINTS} />);
    const svgs = Array.from(
      screen.getByTestId("progress-chart").querySelectorAll<SVGSVGElement>("svg"),
    );
    expect(svgs.length).toBeGreaterThan(0);
    for (const svg of svgs) {
      expect(svg.getAttribute("fill"), svg.getAttribute("data-testid") ?? "svg").toBe("none");
    }
  });

  it("drops the arbitrary-alpha footer band and the retired v1 emphasis classes", () => {
    const { container } = render(<ProgressChart points={POINTS} />);
    const footer = screen.getByTestId("progress-chart-range-controls");
    // The figure IS the --panel well; a --panel band inside it stacks the same tone.
    expect(classesOf(footer).filter((c) => c.startsWith("bg-"))).toEqual([]);
    expectNoRetiredV1(container);
  });

  // DESIGN.md §3 reserves the mono face for "IDs, counts, hours and solver
  // expressions — so a number always reads as data". The visible point count and the
  // tooltip's comment count are counts and were left on the body face.
  it("sets the visible point count in the mono data face", () => {
    render(<ProgressChart points={POINTS} />);
    const count = screen.getByTestId("progress-chart-point-count");
    expect(count.textContent).toBe(`${POINTS.length} of ${POINTS.length} points`);
    const classes = classesOf(count);
    expect(classes).toContain("font-mono");
    expect(classes).not.toContain("font-heading");
  });

  it("sets the tooltip comment count in the mono data face", () => {
    render(<ProgressChart points={POINTS} />);
    // The tooltip renders only while a point is inspected; drive the keyboard
    // inspector rather than simulating a pointer, so this binds the real surface.
    const inspector = screen.getByRole("group", { name: /Progress data points/ });
    fireEvent.focus(inspector);
    const comments = screen.getByTestId("progress-chart-tooltip-comments");
    const classes = classesOf(comments);
    expect(classes).toContain("font-mono");
    // The tabular alignment and the series ink tier are both preserved.
    expect(classes).toContain("tabular-nums");
    expect(comments.getAttribute("style")).toContain("var(--warnink)");
  });

  it("paints series MARKS on the base tier and series TEXT on the ink tier", () => {
    render(<ProgressChart points={POINTS} />);
    const scoreLabel = screen.getByText("Score", { selector: "span" });
    // The label text takes the ink tier so every accent clears AA on the well.
    expect(scoreLabel.getAttribute("style")).toContain("var(--brandink)");
    // Its swatch keeps the exact series hue, so the legend still matches the line.
    const swatch = scoreLabel.previousElementSibling;
    expect(swatch).not.toBeNull();
    expect(swatch!.getAttribute("style")).toContain("var(--brand)");
    expect(swatch!.getAttribute("style")).not.toContain("var(--brandink)");

    const commentLabel = screen.getByText("Comments", { selector: "span" });
    expect(commentLabel.getAttribute("style")).toContain("var(--warnink)");
    expect(commentLabel.previousElementSibling!.getAttribute("style")).toContain("var(--warn)");
  });

  it("strokes the plotted line with the base series hue", () => {
    render(<ProgressChart points={POINTS} />);
    const panel = screen.getByTestId("progress-chart-score-panel");
    const path = panel.querySelector("path");
    expect(path).not.toBeNull();
    expect(path!.getAttribute("stroke")).toBe("var(--brand)");
  });

  // EVERY dot halo punches the line out of the chart's own plane, which is the
  // WELL tone now — haloing against `--surface` leaves a visible L1 ring on a
  // `--panel` plot.
  //
  // The previous form of this test used `panel.querySelector("circle")`, which
  // binds the FIRST ordinary dot and can never see the named latest-point marker;
  // the `--surface` halo on that marker survived a 23-test suite because of it. So
  // each kind is now bound to its own instance, the LATEST markers are addressed by
  // their exact testids, and the count of each kind is premise-guarded — a marker
  // that stops rendering, or a testid that stops matching, fails here instead of
  // silently vacating the assertion.
  it("halos every latest-point marker against the --panel plot plane, by exact instance", () => {
    const { container } = render(<ProgressChart points={POINTS} />);

    const latestDots = Array.from(
      container.querySelectorAll<SVGCircleElement>('[data-testid$="-latest-dot"]'),
    );
    // Both panels carry one: the score panel always, and the comments panel
    // because the latest point's `commentCount` is finite.
    expect(latestDots.map((el) => el.getAttribute("data-testid"))).toEqual([
      "progress-chart-score-panel-latest-dot",
      "progress-chart-comment-panel-latest-dot",
    ]);
    for (const dot of latestDots) {
      const id = dot.getAttribute("data-testid")!;
      expect(dot.getAttribute("stroke"), `${id} halo`).toBe("var(--panel)");
      expect(dot.getAttribute("stroke"), `${id} must not halo against L1`).not.toBe(
        "var(--surface)",
      );
    }
    // Each latest marker carries the series hue as its FILL, so the halo assertion
    // above cannot be satisfied by a marker that lost its series identity.
    expect(latestDots[0].getAttribute("fill")).toBe("var(--brand)");
    expect(latestDots[1].getAttribute("fill")).toBe("var(--warn)");
  });

  it("halos the ordinary per-point dots against the same plot plane", () => {
    render(<ProgressChart points={POINTS} />);
    const panel = screen.getByTestId("progress-chart-score-panel");
    // Ordinary dots are the circles that are NOT the named latest marker. Binding
    // them by exclusion is what proves the latest-dot assertion above is about a
    // genuinely different instance rather than the same element twice.
    const ordinary = Array.from(panel.querySelectorAll<SVGCircleElement>("circle")).filter(
      (el) => !el.hasAttribute("data-testid"),
    );
    expect(ordinary.length).toBe(POINTS.length);
    for (const dot of ordinary) expect(dot.getAttribute("stroke")).toBe("var(--panel)");
  });
});

// A guard against the whole surface silently reverting: none of the retired v1
// utilities may appear in ANY of the route's rendered presentation trees.
describe("no retired v1 presentation survives anywhere on the Optimize surface", () => {
  it("holds across every component tree this ticket owns", () => {
    const trees = [
      render(<ServerIdentity info={SERVER_INFO} />),
      render(<RunEventLog active log={[logEntry(1, "progress")]} />),
      render(<ProgressChart points={POINTS_FOR_SWEEP} />),
      renderOptions(),
      renderStatus({}),
    ];
    for (const tree of trees) expectNoRetiredV1(tree.container);
    expect(trees).toHaveLength(5);
    vi.restoreAllMocks();
  });
});

/** The real solver source the backend emits on a progress frame. */
const POINTS_WITH_SOLVER_SOURCE = [
  {
    source: "ortools/cp-sat:solution-callback",
    currentBestScore: 8,
    elapsedSeconds: 2,
    solutionIndex: 1,
    commentCount: 0,
  },
];

const POINTS_FOR_SWEEP = [
  { source: "solver", currentBestScore: 8, elapsedSeconds: 2, solutionIndex: 1, commentCount: 0 },
  { source: "solver", currentBestScore: 12, elapsedSeconds: 5, solutionIndex: 2, commentCount: 1 },
];
