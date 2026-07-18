import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { prepareScenarioLoad, toCanonicalScenarioDocument } from "@/lib/scenario";
import { makeValidUiState } from "@/lib/scenario/test-fixtures";
import type { CanonicalScenarioDocument, ImportNormalizationTarget } from "@/lib/scenario";
import {
  buildSampleScenarioYaml,
  hasUncreditedLeave,
  UNCREDITED_LEAVE_WARNING,
  versionMismatchCopy,
} from "./load-controls-core";

const YAML_OPTIONS = { version: "1.2" as const };

/** `makeValidUiState()` already carries one leave-pin cell (Alice, 2026-05-14). */
function baseDocWithLeavePin(): CanonicalScenarioDocument {
  return toCanonicalScenarioDocument(makeValidUiState());
}

function targetFromDoc(doc: CanonicalScenarioDocument): ImportNormalizationTarget {
  const result = prepareScenarioLoad(stringify(doc, YAML_OPTIONS));
  if (!result.target) throw new Error("expected a target");
  return result.target;
}

function markedContractPreference(
  countShiftTypes: string | string[],
  coefficients: [string, number][],
): CanonicalScenarioDocument["preferences"][number] {
  return {
    type: "shift count",
    person: "ALL",
    countDates: "ALL",
    countShiftTypes,
    countShiftTypeCoefficients: coefficients,
    expression: "x = T",
    target: 100,
    hoursContract: { unit: "half-hour", policy: "exact" },
    weight: Infinity,
  } as CanonicalScenarioDocument["preferences"][number];
}

describe("versionMismatchCopy — FR-SL-19 verbatim wording", () => {
  it("missing — verbatim byte-for-byte text", () => {
    const { description } = versionMismatchCopy("missing", undefined, "1.4.0");
    expect(description).toBe(
      "The loaded file does not contain app version information. It may have been created " +
        "with an older version of the application. Current app version: 1.4.0",
    );
  });

  it("dirty — verbatim byte-for-byte text, including the embedded paragraph breaks", () => {
    const { description } = versionMismatchCopy("dirty", "1.4.0-dirty", "1.4.0");
    expect(description).toBe(
      "Dirty app version detected.\n\n" +
        "File app version: 1.4.0-dirty\n" +
        "Current app version: 1.4.0\n\n" +
        "This YAML was created by a development build with uncommitted changes. It may not " +
        "match a reproducible application version. If nothing breaks, you can continue.",
    );
  });

  it("mismatch — verbatim byte-for-byte text, including the embedded paragraph breaks", () => {
    const { description } = versionMismatchCopy("mismatch", "1.0.0", "1.4.0");
    expect(description).toBe(
      "App version mismatch detected.\n\n" +
        "File app version: 1.0.0\n" +
        "Current app version: 1.4.0\n\n" +
        "Older YAML may not work after breaking changes, though we try to preserve compatibility. " +
        "If nothing breaks, you can continue.",
    );
  });
});

describe("hasUncreditedLeave", () => {
  it("no marked contracted-hours count → false, even with a leave pin", () => {
    const target = targetFromDoc(baseDocWithLeavePin());
    expect(hasUncreditedLeave(target)).toBe(false);
  });

  it("marked contract missing LEAVE + a leave pin → true", () => {
    const doc = baseDocWithLeavePin();
    doc.preferences.push(markedContractPreference("D", [["D", 1]]));
    expect(hasUncreditedLeave(targetFromDoc(doc))).toBe(true);
  });

  it("marked contract that DOES include LEAVE → false", () => {
    const doc = baseDocWithLeavePin();
    doc.preferences.push(
      markedContractPreference(
        ["D", "LEAVE"],
        [
          ["D", 1],
          ["LEAVE", 16],
        ],
      ),
    );
    expect(hasUncreditedLeave(targetFromDoc(doc))).toBe(false);
  });

  it("an unresolved selector suppresses the check (no false positive)", () => {
    const doc = baseDocWithLeavePin();
    doc.preferences.push(markedContractPreference("NOT_A_REAL_SHIFT_TYPE", [["D", 1]]));
    expect(hasUncreditedLeave(targetFromDoc(doc))).toBe(false);
  });

  it("no leave pin at all → false, even with a marked contract missing LEAVE", () => {
    const doc = baseDocWithLeavePin();
    doc.preferences.push(markedContractPreference("D", [["D", 1]]));
    const withLeave = targetFromDoc(doc);
    const withoutLeavePin: ImportNormalizationTarget = {
      ...withLeave,
      reqData: withLeave.reqData.filter((cell) => cell.kind !== "leave"),
    };
    expect(hasUncreditedLeave(withoutLeavePin)).toBe(false);
  });
});

describe("UNCREDITED_LEAVE_WARNING", () => {
  it("is a non-empty, human-readable line", () => {
    expect(UNCREDITED_LEAVE_WARNING.length).toBeGreaterThan(0);
    expect(UNCREDITED_LEAVE_WARNING).toMatch(/LEAVE/);
  });
});

describe("buildSampleScenarioYaml", () => {
  it("produces YAML that prepareScenarioLoad accepts with no issues", () => {
    const result = prepareScenarioLoad(buildSampleScenarioYaml());
    expect(result.issues).toEqual([]);
    expect(result.target).not.toBeNull();
    expect(result.target!.reqData.some((cell) => cell.kind === "leave")).toBe(true);
  });
});
