// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { stringify } from "yaml";
import { makeValidUiState } from "@/lib/scenario/test-fixtures";
import {
  formatUncreditedLeaveWarning,
  serializeScenario,
  toCanonicalScenarioDocument,
  type CanonicalScenarioDocument,
  type ImportNormalizationTarget,
  type PrepareScenarioLoadResult,
} from "@/lib/scenario";
import { UNSUPPORTED_EXPRESSION_REASON } from "@/lib/optimize/optimize-readiness";

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

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// C-23: a Load clears the saved roster first. A spy, so order and failure are provable.
vi.mock("@/lib/roster", async (orig) => {
  const actual = await orig<typeof import("@/lib/roster")>();
  return { ...actual, clearRosterDataAndNotify: vi.fn() };
});

import { prepareScenarioLoad } from "@/lib/scenario";
import { loadScenario, isScenarioSliceEmpty } from "@/lib/store";
import { clearRosterDataAndNotify } from "@/lib/roster";
import { toast } from "sonner";
import { LOAD_ROSTER_CLEAR_FAILED, useScenarioImport } from "./use-scenario-import";

const clearRosterMock = clearRosterDataAndNotify as unknown as Mock;

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
  expression: "x = T",
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

/** The outcome a successful atomic scenario switch resolves with. */
const LOADED = { ok: true, committed: true, documentRevision: 1, commitId: null } as const;

beforeEach(() => {
  prepareMock.mockReset();
  // T03F1: the commit AWAITS and BRANCHES ON the switch outcome, so the spy has to
  // resolve one. That is the point of the change — a refused switch must no longer be
  // reported as a successful load (see the refusal test at the end).
  loadScenarioMock.mockReset().mockResolvedValue(LOADED);
  isEmptyMock.mockReset().mockReturnValue(true);
  clearRosterMock.mockReset().mockResolvedValue({ status: "cleared" });
  (toast.success as unknown as Mock).mockReset();
  (toast.error as unknown as Mock).mockReset();
});

afterEach(() => {
  cleanup();
});

describe("useScenarioImport — guard warnings computed before load", () => {
  it("direct path: publishes the named guard warning from the pre-load target and loads exactly once", async () => {
    stageResult(targetWithCounts([MARKED_CONTRACT]));
    const { result } = renderHook(() => useScenarioImport());

    await act(async () => result.current.handleFile("<yaml>"));

    // No-op loadScenario ⇒ if the guard read post-load state it would see nothing.
    expect(result.current.warnings).toEqual([IMPORT_ALICE_WARNING]);
    expect(loadScenarioMock).toHaveBeenCalledTimes(1);
    expect(result.current.confirm).toBeNull();
  });

  it("keeps two unsafe counts for the same person distinguishable", async () => {
    stageResult(
      targetWithCounts([
        { ...MARKED_CONTRACT, description: "Night coverage" },
        { ...MARKED_CONTRACT, description: "Night coverage" },
      ]),
    );
    const { result } = renderHook(() => useScenarioImport());

    await act(async () => result.current.handleFile("<yaml>"));

    expect(result.current.warnings).toEqual([
      `"Night coverage" (count 1): ${ALICE_WARNING}`,
      `"Night coverage" (count 2): ${ALICE_WARNING}`,
    ]);
  });
  it("a disabled imported marked count produces no guard warning", async () => {
    stageResult(targetWithCounts([{ ...MARKED_CONTRACT, disabled: true }]));
    const { result } = renderHook(() => useScenarioImport());

    await act(async () => result.current.handleFile("<yaml>"));

    expect(result.current.warnings).toBeNull();
    expect(loadScenarioMock).toHaveBeenCalledTimes(1);
  });

  it("one unresolved count does not hide an independent valid finding", async () => {
    stageResult(
      targetWithCounts([
        { ...MARKED_CONTRACT, uid: "bad", countShiftTypes: "NOT_A_SHIFT" },
        MARKED_CONTRACT,
      ]),
    );
    const { result } = renderHook(() => useScenarioImport());

    await act(async () => result.current.handleFile("<yaml>"));

    expect(result.current.warnings).toEqual([`Count 2: ${ALICE_WARNING}`]);
  });

  it("merges and deduplicates base warnings with guard warnings", async () => {
    stageResult(targetWithCounts([MARKED_CONTRACT]), [
      "base advanced-syntax warning",
      IMPORT_ALICE_WARNING,
    ]);
    const { result } = renderHook(() => useScenarioImport());

    await act(async () => result.current.handleFile("<yaml>"));

    // base first, guard line appears once despite the base list already carrying it.
    expect(result.current.warnings).toEqual(["base advanced-syntax warning", IMPORT_ALICE_WARNING]);
  });

  it("staged (confirm) path publishes the same list only after Continue, loading once", async () => {
    isEmptyMock.mockReturnValue(false); // non-empty workspace ⇒ combined confirm
    stageResult(targetWithCounts([MARKED_CONTRACT]));
    const { result } = renderHook(() => useScenarioImport());

    // Not awaited: a staged load settles only once its confirm does.
    let loaded!: Promise<void>;
    await act(async () => {
      loaded = result.current.handleFile("<yaml>");
    });
    // Warnings are staged, not yet published; nothing has loaded.
    expect(result.current.warnings).toBeNull();
    expect(result.current.confirm).not.toBeNull();
    expect(loadScenarioMock).not.toHaveBeenCalled();

    await act(async () => result.current.confirm!.onContinue());
    expect(result.current.warnings).toEqual([IMPORT_ALICE_WARNING]);
    expect(loadScenarioMock).toHaveBeenCalledTimes(1);
    await loaded; // settles once the confirmed load has (7vtc)
  });

  it("onContinue settles only after the load has committed (nursing-sheduler-iks)", async () => {
    // The confirm holds its busy state on this promise; settling early reopened the
    // window in which a hard reload aborts the IndexedDB switch.
    isEmptyMock.mockReturnValue(false);
    let commitLoad!: (outcome: { ok: true }) => void;
    loadScenarioMock.mockReturnValue(new Promise((resolve) => (commitLoad = resolve)));
    stageResult(targetWithCounts([MARKED_CONTRACT]));
    const { result } = renderHook(() => useScenarioImport());
    await act(async () => {
      void result.current.handleFile("<yaml>");
    });

    let settled = false;
    let continued!: Promise<void>;
    act(() => {
      continued = result.current.confirm!.onContinue().then(() => {
        settled = true;
      });
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(toast.success).not.toHaveBeenCalled();

    await act(async () => {
      commitLoad({ ok: true });
      await continued;
    });
    expect(settled).toBe(true);
    expect(toast.success).toHaveBeenCalledOnce();
  });

  it("a REFUSED switch keeps the staged file and reports no success", async () => {
    // T03F1 finding 5. The commit used to clear staging and toast "Scenario loaded"
    // before the switch had settled — so a refusal (this tab is read-only, or was
    // taken over mid-dialog) destroyed the user's staged upload and told them it had
    // worked. The same file must remain retryable after taking editing back.
    isEmptyMock.mockReturnValue(false); // stage the confirmation
    loadScenarioMock.mockResolvedValue({ ok: false, reason: "not-owner", code: "not_owner" });
    stageResult(targetWithCounts([MARKED_CONTRACT]));
    const { result } = renderHook(() => useScenarioImport());

    await act(async () => {
      void result.current.handleFile("<yaml>");
    });
    expect(result.current.confirm).not.toBeNull();

    await act(async () => result.current.confirm!.onContinue());

    // The staged confirmation survives, and nothing claims to have loaded.
    expect(result.current.confirm).not.toBeNull();
    expect(result.current.warnings).toBeNull();
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalled();
  });
});

describe("useScenarioImport — Load clears the saved roster (C-23)", () => {
  it("clears the roster before the switch", async () => {
    stageResult(targetWithCounts([]));
    const { result } = renderHook(() => useScenarioImport());
    await act(async () => result.current.handleFile("<yaml>"));
    expect(clearRosterMock).toHaveBeenCalledOnce();
    expect(clearRosterMock.mock.invocationCallOrder[0]).toBeLessThan(
      loadScenarioMock.mock.invocationCallOrder[0]!,
    );
  });

  it("an unverified clear loads nothing and says so", async () => {
    clearRosterMock.mockResolvedValue({ status: "failed" });
    stageResult(targetWithCounts([]));
    const { result } = renderHook(() => useScenarioImport());
    await act(async () => result.current.handleFile("<yaml>"));
    expect(loadScenarioMock).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(LOAD_ROSTER_CLEAR_FAILED);
  });

  it("an Edit-YAML apply keeps the roster", async () => {
    stageResult(targetWithCounts([]));
    const { result } = renderHook(() => useScenarioImport());
    await act(async () => result.current.handleEdit("<yaml>"));
    expect(clearRosterMock).not.toHaveBeenCalled();
  });
});

describe("useScenarioImport — an older file with issues still loads (C-22)", () => {
  const ISSUE = { path: "preferences[3]", message: "weight must be '.inf'" };

  function stageWithIssues() {
    prepareMock.mockReturnValue({
      issues: [],
      warnings: [],
      target: targetWithCounts([]),
      doc: null,
      optimizeIssues: [ISSUE],
    } satisfies PrepareScenarioLoadResult);
  }

  it("loads and keeps the issues to show as warnings", async () => {
    stageWithIssues();
    const { result } = renderHook(() => useScenarioImport());
    await act(async () => result.current.handleFile("<yaml>"));
    expect(loadScenarioMock).toHaveBeenCalledOnce();
    expect(result.current.issues).toBeNull();
    expect(result.current.loadIssues).toEqual([ISSUE]);
  });

  it("a v1 Leave file is offered conversion first, then loads with its issues (objg + C-22)", async () => {
    const plan = {
      shiftId: "Leave",
      shiftIndex: 2,
      convertedRequests: 1,
      droppedRequests: 0,
      historyEntries: 0,
      blockers: [],
      leaveLikeIds: ["Leave"],
      allShiftRules: 0,
      convertible: true,
      doc: null,
    };
    prepareMock.mockImplementation((_raw: string, opts?: { convertV1LeaveShift?: boolean }) =>
      opts?.convertV1LeaveShift
        ? {
            issues: [],
            warnings: [],
            target: targetWithCounts([]),
            doc: null,
            optimizeIssues: [ISSUE],
          }
        : {
            issues: [{ path: "shiftTypes.items[2]", message: "rename" }],
            warnings: [],
            target: null,
            doc: null,
            v1LeaveShift: plan,
          },
    );
    const { result } = renderHook(() => useScenarioImport());
    await act(async () => {
      void result.current.handleFile("<yaml>");
    });
    expect(loadScenarioMock).not.toHaveBeenCalled();
    await act(async () => result.current.confirm!.onContinue());
    expect(clearRosterMock).toHaveBeenCalledOnce();
    expect(loadScenarioMock).toHaveBeenCalledOnce();
    expect(result.current.loadIssues).toEqual([ISSUE]);
  });

  it("an Edit-YAML draft with the same issues is still refused", async () => {
    stageWithIssues();
    const { result } = renderHook(() => useScenarioImport());
    await act(async () => result.current.handleEdit("<yaml>"));
    expect(loadScenarioMock).not.toHaveBeenCalled();
    expect(result.current.issues).toEqual([ISSUE]);
    expect(result.current.loadIssues).toBeNull();
  });
});

describe("useScenarioImport — unsupported shift-count expression (wa46)", () => {
  /** A real file through the REAL `prepareScenarioLoad`, one extra count appended. */
  async function importYaml(raw: string) {
    const actual = await vi.importActual<typeof import("@/lib/scenario")>("@/lib/scenario");
    prepareMock.mockImplementation(actual.prepareScenarioLoad);
    const { result } = renderHook(() => useScenarioImport());
    await act(async () => result.current.handleFile(raw));
    return result;
  }

  function yamlWithCount(expression: string): string {
    const doc = toCanonicalScenarioDocument(makeValidUiState());
    doc.preferences.push({
      type: "shift count",
      person: "Alice",
      countDates: "ALL",
      countShiftTypes: "D",
      expression,
      target: 1,
      weight: 1,
    } as CanonicalScenarioDocument["preferences"][number]);
    return stringify(doc, { version: "1.2" });
  }

  it('loads a file whose count uses "x >= 0" and warns it must be edited before Optimize', async () => {
    const result = await importYaml(yamlWithCount("x >= 0"));

    expect(result.current.issues).toBeNull();
    expect(loadScenarioMock).toHaveBeenCalledTimes(1);
    expect(result.current.warnings).toContain(UNSUPPORTED_EXPRESSION_REASON);
  });

  it("a supported expression adds no such warning", async () => {
    const result = await importYaml(yamlWithCount("x >= T"));
    expect(loadScenarioMock).toHaveBeenCalledTimes(1);
    expect(result.current.warnings ?? []).not.toContain(UNSUPPORTED_EXPRESSION_REASON);
    await act(async () => result.current.clearImportState());

    const plain = await importYaml(serializeScenario(makeValidUiState()));
    expect(plain.current.warnings ?? []).not.toContain(UNSUPPORTED_EXPRESSION_REASON);
  });
});
