// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { makeValidUiState } from "@/lib/scenario/test-fixtures";
import {
  formatUncreditedLeaveWarning,
  type ImportNormalizationTarget,
  type PrepareScenarioLoadResult,
} from "@/lib/scenario";

// Keep the real scenario library (detector, adapters, formatter) — only the
// inbound `prepareScenarioLoad` is stubbed so a marked contract can be staged
// without round-tripping through the strict producer.
vi.mock("@/lib/scenario", async (orig) => {
  const actual = await orig<typeof import("@/lib/scenario")>();
  return { ...actual, prepareScenarioLoad: vi.fn() };
});

// `loadScenario` is a no-op spy: if the guard were (wrongly) computed from the
// post-load store instead of the pre-load target, the store would stay empty and
// no warning would appear. A warning surviving a no-op load proves the guard runs
// against the unchanged target BEFORE replacement. `isScenarioSliceEmpty` is
// controllable so a test can force the staged (confirm) path.
vi.mock("@/lib/store", async (orig) => {
  const actual = await orig<typeof import("@/lib/store")>();
  return {
    ...actual,
    loadScenario: vi.fn(),
    isScenarioSliceEmpty: vi.fn(() => true),
  };
});

vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));

import { prepareScenarioLoad } from "@/lib/scenario";
import { loadScenario, isScenarioSliceEmpty } from "@/lib/store";
import { useScenarioImport } from "./use-scenario-import";

const prepareMock = prepareScenarioLoad as unknown as Mock;
const loadScenarioMock = loadScenario as unknown as Mock;
const isEmptyMock = isScenarioSliceEmpty as unknown as Mock;

/**
 * A keyless import target built from the shared fixture (Alice has a leave pin on
 * 2026-05-14). `counts` accepts extra `disabled`/second-card overrides so a test
 * can exercise the disabled and independent-finding cases. Cast from the durable
 * fixture — `ImportCard<CountCardBody>` is structurally a superset.
 */
function targetWithCounts(counts: readonly Record<string, unknown>[]): ImportNormalizationTarget {
  const state = makeValidUiState();
  (state.cardsByKind.counts as unknown) = counts;
  return state as unknown as ImportNormalizationTarget;
}

const MARKED_CONTRACT = {
  uid: "ch1",
  tag: "contracted_hours",
  policy: "exact",
  person: "ALL",
  countDates: "ALL",
  countShiftTypes: "D",
  expression: "==",
  target: 1,
  weight: -1,
};

const ALICE_WARNING = formatUncreditedLeaveWarning(["Alice"]);
const IMPORT_ALICE_WARNING = `Count 1: ${ALICE_WARNING}`;

function stageResult(target: ImportNormalizationTarget, warnings: string[] = []) {
  prepareMock.mockReturnValue({
    issues: [],
    warnings,
    target,
    doc: null,
  } satisfies PrepareScenarioLoadResult);
}

beforeEach(() => {
  prepareMock.mockReset();
  loadScenarioMock.mockReset();
  isEmptyMock.mockReset().mockReturnValue(true);
});

afterEach(() => {
  cleanup();
});

describe("useScenarioImport — guard warnings computed before load", () => {
  it("direct path: publishes the named guard warning from the pre-load target and loads exactly once", () => {
    stageResult(targetWithCounts([MARKED_CONTRACT]));
    const { result } = renderHook(() => useScenarioImport());

    act(() => result.current.handleFile("<yaml>"));

    // No-op loadScenario ⇒ if the guard read post-load state it would see nothing.
    expect(result.current.warnings).toEqual([IMPORT_ALICE_WARNING]);
    expect(loadScenarioMock).toHaveBeenCalledTimes(1);
    expect(result.current.confirm).toBeNull();
  });

  it("keeps two unsafe counts for the same person distinguishable", () => {
    stageResult(
      targetWithCounts([
        { ...MARKED_CONTRACT, description: "Night coverage" },
        { ...MARKED_CONTRACT, description: "Night coverage" },
      ]),
    );
    const { result } = renderHook(() => useScenarioImport());

    act(() => result.current.handleFile("<yaml>"));

    expect(result.current.warnings).toEqual([
      `"Night coverage" (count 1): ${ALICE_WARNING}`,
      `"Night coverage" (count 2): ${ALICE_WARNING}`,
    ]);
  });
  it("a disabled imported marked count produces no guard warning", () => {
    stageResult(targetWithCounts([{ ...MARKED_CONTRACT, disabled: true }]));
    const { result } = renderHook(() => useScenarioImport());

    act(() => result.current.handleFile("<yaml>"));

    expect(result.current.warnings).toBeNull();
    expect(loadScenarioMock).toHaveBeenCalledTimes(1);
  });

  it("one unresolved count does not hide an independent valid finding", () => {
    stageResult(
      targetWithCounts([
        { ...MARKED_CONTRACT, uid: "bad", countShiftTypes: "NOT_A_SHIFT" },
        MARKED_CONTRACT,
      ]),
    );
    const { result } = renderHook(() => useScenarioImport());

    act(() => result.current.handleFile("<yaml>"));

    expect(result.current.warnings).toEqual([`Count 2: ${ALICE_WARNING}`]);
  });

  it("merges and deduplicates base warnings with guard warnings", () => {
    stageResult(targetWithCounts([MARKED_CONTRACT]), [
      "base advanced-syntax warning",
      IMPORT_ALICE_WARNING,
    ]);
    const { result } = renderHook(() => useScenarioImport());

    act(() => result.current.handleFile("<yaml>"));

    // base first, guard line appears once despite the base list already carrying it.
    expect(result.current.warnings).toEqual(["base advanced-syntax warning", IMPORT_ALICE_WARNING]);
  });

  it("staged (confirm) path publishes the same list only after Continue, loading once", () => {
    isEmptyMock.mockReturnValue(false); // non-empty workspace ⇒ combined confirm
    stageResult(targetWithCounts([MARKED_CONTRACT]));
    const { result } = renderHook(() => useScenarioImport());

    act(() => result.current.handleFile("<yaml>"));
    // Warnings are staged, not yet published; nothing has loaded.
    expect(result.current.warnings).toBeNull();
    expect(result.current.confirm).not.toBeNull();
    expect(loadScenarioMock).not.toHaveBeenCalled();

    act(() => result.current.confirm!.onContinue());
    expect(result.current.warnings).toEqual([IMPORT_ALICE_WARNING]);
    expect(loadScenarioMock).toHaveBeenCalledTimes(1);
  });
});
