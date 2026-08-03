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
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { surfaceVariants } from "@/components/ui/surface";
import {
  INITIAL_OPTIMIZE_RUN_VIEW,
  type OptimizeRunView,
  type OptimizeServerInfo,
  type RunLogEntry,
  type RunLogKind,
} from "@/lib/optimize";
import { Callout, type CalloutTone } from "./callout";
import { ReadinessBanner } from "./readiness-banner";
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
// Event log
// ---------------------------------------------------------------------------

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

const POINTS_FOR_SWEEP = [
  { source: "solver", currentBestScore: 8, elapsedSeconds: 2, solutionIndex: 1, commentCount: 0 },
  { source: "solver", currentBestScore: 12, elapsedSeconds: 5, solutionIndex: 2, commentCount: 1 },
];
