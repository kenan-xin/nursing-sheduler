import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import {
  classifyLoadVersion,
  prepareScenarioLoad,
  projectImportTarget,
} from "./prepare-scenario-load";
import { toCanonicalScenarioDocument } from "./canonical";
import { serializeScenario } from "./serialize";
import { makeValidUiState } from "./test-fixtures";
import type { CanonicalScenarioDocument } from "./types";
import {
  computeScenarioFingerprint,
  createMemoryStorage,
  createStateSpine,
  hydrateScenarioStore,
  pickScenario,
} from "@/lib/store";

const YAML_OPTIONS = { version: "1.2" as const };

/** A backend-valid YAML string (the F2 serializer's own output). */
function validYaml(): string {
  return serializeScenario(makeValidUiState());
}

/** A canonical doc with an extra preference appended, dumped past the validator. */
function docWithExtraPreference(extra: CanonicalScenarioDocument["preferences"][number]): string {
  const doc = toCanonicalScenarioDocument(makeValidUiState());
  doc.preferences.push(extra);
  return stringify(doc, YAML_OPTIONS);
}

describe("prepareScenarioLoad — happy path", () => {
  it("valid YAML returns no issues, a doc, and the unchanged keyless target", () => {
    const result = prepareScenarioLoad(validYaml());

    expect(result.issues).toEqual([]);
    expect(result.doc).not.toBeNull();
    expect(result.target).not.toBeNull();
    // The target is keyless: card bodies carry no store-assigned `uid`.
    for (const card of result.target!.cardsByKind.requirements) {
      expect("uid" in card).toBe(false);
    }
    // Import copied the file's appVersion into meta (integrity metadata only).
    expect(result.target!.meta.apiVersion).toBe("alpha");
  });
});

describe("prepareScenarioLoad — blocking issues", () => {
  it("a YAML syntax error surfaces on the issue channel with no doc", () => {
    const result = prepareScenarioLoad("preferences: [unterminated, flow");

    expect(result.doc).toBeNull();
    expect(result.target).toBeNull();
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues[0].message).toMatch(/YAML parse error/);
  });

  it("an import-invalid document surfaces schema V-messages (no target, no doc)", () => {
    // Well-formed YAML, but missing every required container.
    const result = prepareScenarioLoad("apiVersion: alpha\n");

    expect(result.target).toBeNull();
    expect(result.doc).toBeNull();
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it("a bad marked contract passes import but fails producer preflight", () => {
    const raw = docWithExtraPreference({
      type: "shift count",
      person: "Alice",
      countDates: "ALL",
      countShiftTypes: "D",
      countShiftTypeCoefficients: [["D", 1]],
      expression: "x = T",
      target: 20,
      // A marked contract MUST use weight `.inf`; 1 is the injected defect.
      hoursContract: { unit: "half-hour", policy: "exact" },
      weight: 1,
    } as CanonicalScenarioDocument["preferences"][number]);

    const result = prepareScenarioLoad(raw);

    // Import succeeded (we got a target + a projected doc)…
    expect(result.target).not.toBeNull();
    // …but the producer contracted-hours validator rejects it.
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues.some((issue) => /weight '\.inf'/.test(issue.message))).toBe(true);
  });
});

describe("prepareScenarioLoad — non-blocking warnings", () => {
  it("advanced (nested) reference syntax survivors populate warnings, not issues", () => {
    const raw = docWithExtraPreference({
      type: "shift type successions",
      person: "Alice",
      // A nested reference tree (an array holding an array) — advanced syntax.
      pattern: [["D", "E"]],
      weight: 1,
    } as CanonicalScenarioDocument["preferences"][number]);

    const result = prepareScenarioLoad(raw);

    expect(result.issues).toEqual([]);
    expect(result.doc).not.toBeNull();
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.some((w) => /advanced backend reference syntax/.test(w))).toBe(true);
  });

  it("deduplicates identical advanced-syntax warnings", () => {
    // Two successions with the same nested-pattern survivor → one banner line.
    const doc = toCanonicalScenarioDocument(makeValidUiState());
    for (let i = 0; i < 2; i++) {
      doc.preferences.push({
        type: "shift type successions",
        person: "Alice",
        pattern: [["D", "E"]],
        weight: 1,
      } as CanonicalScenarioDocument["preferences"][number]);
    }
    const result = prepareScenarioLoad(stringify(doc, YAML_OPTIONS));

    const advanced = result.warnings.filter((w) => /advanced backend reference syntax/.test(w));
    expect(advanced.length).toBe(1);
  });
});

describe("projectImportTarget — determinism", () => {
  it("projects the same target to an identical canonical document across calls", () => {
    const { target } = prepareScenarioLoad(validYaml());
    expect(target).not.toBeNull();

    const first = projectImportTarget(target!);
    const second = projectImportTarget(target!);

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});

describe("classifyLoadVersion — Decision A tier → load behavior", () => {
  it("identical (same full string) → null (silent, no modal)", () => {
    expect(classifyLoadVersion("v0.1.1-5-gabc1234", "v0.1.1-5-gabc1234")).toBeNull();
  });

  it("compatible (same major.minor, different commit) → null (silent — stop per-commit nagging)", () => {
    expect(classifyLoadVersion("v0.1.1-5-gabc1234", "v0.1.1-6-gdef5678")).toBeNull();
  });

  it("indeterminate (bare hash — no tag to judge) → null (silent, don't cry wolf)", () => {
    expect(classifyLoadVersion("abc1234", "v0.1.1-5-gabc1234")).toBeNull();
  });

  it("missing (absent or sentinel file version) → 'missing' confirm", () => {
    expect(classifyLoadVersion(undefined, "v0.1.1")).toBe("missing");
    expect(classifyLoadVersion("", "v0.1.1")).toBe("missing");
    expect(classifyLoadVersion("unknown", "v0.1.1")).toBe("missing");
  });

  it("dirty (one side -dirty, strings differ) → 'dirty' confirm", () => {
    expect(classifyLoadVersion("v0.1.1-5-gabc1234-dirty", "v0.1.1-5-gabc1234")).toBe("dirty");
  });

  it("equal dirty (exactly-matching dirty file + build) → 'dirty' confirm, not a silent load", () => {
    // Two equal `-dirty` strings do NOT prove identical code — uncommitted
    // changes are not captured in the version string — so this must stage a
    // confirm rather than load silently.
    expect(classifyLoadVersion("v0.1.1-5-gabc1234-dirty", "v0.1.1-5-gabc1234-dirty")).toBe("dirty");
  });

  it("incompatible (major.minor differ) → 'incompatible' confirm", () => {
    expect(classifyLoadVersion("v0.1.1", "v0.2.0")).toBe("incompatible");
    expect(classifyLoadVersion("v0.1.1", "v1.0.0")).toBe("incompatible");
  });

  it("normalizes an optional leading v — bare-semver file on the same line stays silent", () => {
    expect(classifyLoadVersion("0.1.5", "v0.1.9")).toBeNull();
  });

  // Self-unknown-silent: if my own build can't identify itself, I can't judge any
  // file's compatibility, so don't nag (mirrors surface (a)'s null guard).
  it("current build unidentifiable + file has a real version → silent (null)", () => {
    expect(classifyLoadVersion("v0.1.1", "unknown")).toBeNull();
    expect(classifyLoadVersion("v0.1.1", "")).toBeNull();
    expect(classifyLoadVersion("v0.1.1", "v0.0.0-unknown")).toBeNull();
  });

  it("current build unidentifiable + file missing → silent (null)", () => {
    expect(classifyLoadVersion(undefined, "unknown")).toBeNull();
  });

  it("current build KNOWN + file missing → still 'missing' confirm (regression guard)", () => {
    expect(classifyLoadVersion(undefined, "v0.1.1")).toBe("missing");
  });

  it("current build KNOWN + file dirty/incompatible → still confirm as before", () => {
    expect(classifyLoadVersion("v0.1.1-5-gabc1234-dirty", "v0.1.1-5-gabc1234")).toBe("dirty");
    expect(classifyLoadVersion("v0.2.0", "v0.1.1")).toBe("incompatible");
  });
});

describe("prepareScenarioLoad — the no-mutation lock", () => {
  async function readySpine() {
    const spine = createStateSpine({ createStorage: () => createMemoryStorage() });
    await hydrateScenarioStore(spine.scenario, spine.hot);
    spine.scenario.getState().mutateScenario({ rangeStart: "2026-02-01", rangeEnd: "2026-02-28" });
    spine.scenario.getState().recordBackup();
    return spine;
  }

  interface StoreSnapshot {
    fingerprint: string;
    backup: string | null;
    state: string;
    past: number;
    future: number;
  }

  function snapshot(spine: Awaited<ReturnType<typeof readySpine>>): StoreSnapshot {
    const state = spine.scenario.getState();
    return {
      fingerprint: computeScenarioFingerprint(pickScenario(state)),
      backup: state.backupFingerprint,
      state: JSON.stringify(pickScenario(state)),
      past: spine.scenario.temporal.getState().pastStates.length,
      future: spine.scenario.temporal.getState().futureStates.length,
    };
  }

  it("leaves the store fingerprint / state / history byte-for-byte unchanged on invalid input", async () => {
    const spine = await readySpine();
    const before = snapshot(spine);

    // A blocking bad-marked-contract AND a syntax error — neither may touch the store.
    const badContract = (() => {
      const doc = toCanonicalScenarioDocument(makeValidUiState());
      doc.preferences.push({
        type: "shift count",
        person: "Alice",
        countDates: "ALL",
        countShiftTypes: "D",
        countShiftTypeCoefficients: [["D", 1]],
        expression: "x = T",
        target: 20,
        hoursContract: { unit: "half-hour", policy: "exact" },
        weight: 1,
      } as CanonicalScenarioDocument["preferences"][number]);
      return stringify(doc, YAML_OPTIONS);
    })();

    const contractResult = prepareScenarioLoad(badContract);
    const syntaxResult = prepareScenarioLoad("preferences: [unterminated");

    // Both are blocking…
    expect(contractResult.issues.length).toBeGreaterThan(0);
    expect(syntaxResult.issues.length).toBeGreaterThan(0);

    // …and the store is untouched.
    expect(snapshot(spine)).toEqual(before);
  });
});
