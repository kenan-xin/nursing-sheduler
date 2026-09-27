import { describe, expect, it } from "vitest";
import { prepareScenarioLoad } from "@/lib/scenario";
import {
  buildSampleScenarioYaml,
  loadConfirmCopy,
  REPLACEMENT_CONFIRM_BODY,
  REPLACEMENT_CONFIRM_TITLE,
  versionMismatchCopy,
} from "./load-controls-core";

describe("versionMismatchCopy — FR-SL-19 verbatim wording", () => {
  it("missing — verbatim byte-for-byte text; no version pair to box", () => {
    const { description, detail } = versionMismatchCopy("missing", undefined, "1.4.0");
    expect(description).toBe(
      "The loaded file does not contain app version information. It may have been created " +
        "with an older version of the application. Current app version: 1.4.0",
    );
    expect(detail).toBeUndefined();
  });

  it("dirty — verbatim byte-for-byte text; the version pair moves to the mono detail box", () => {
    const { description, detail } = versionMismatchCopy("dirty", "1.4.0-dirty", "1.4.0");
    expect(description).toBe(
      "Dirty app version detected.\n\n" +
        "This YAML was created by a development build with uncommitted changes. It may not " +
        "match a reproducible application version. If nothing breaks, you can continue.",
    );
    expect(detail).toBe("File app version: 1.4.0-dirty\nCurrent app version: 1.4.0");
  });

  it("incompatible — verbatim byte-for-byte text; the version pair moves to the mono detail box", () => {
    const { description, detail } = versionMismatchCopy("incompatible", "1.0.0", "1.4.0");
    expect(description).toBe(
      "App version mismatch detected.\n\n" +
        "Older YAML may not work after breaking changes, though we try to preserve compatibility. " +
        "If nothing breaks, you can continue.",
    );
    expect(detail).toBe("File app version: 1.0.0\nCurrent app version: 1.4.0");
  });
});

describe("loadConfirmCopy — the detail box rides with the version case only", () => {
  it("a replacement + version confirm keeps the merged lead and carries the version box", () => {
    const copy = loadConfirmCopy("incompatible", true, "1.0.0", "1.4.0");
    expect(copy.title).toBe(REPLACEMENT_CONFIRM_TITLE);
    // Unchanged from the pre-existing merge: the replacement lead, then the
    // version title as the merged half's label, then the version wording.
    expect(copy.description).toBe(
      `${REPLACEMENT_CONFIRM_BODY}\n\nApp version mismatch detected\n\n` +
        "App version mismatch detected.\n\n" +
        "Older YAML may not work after breaking changes, though we try to preserve compatibility. " +
        "If nothing breaks, you can continue.",
    );
    expect(copy.detail).toBe("File app version: 1.0.0\nCurrent app version: 1.4.0");
  });

  it("a version-only confirm carries the box; a replacement-only confirm does not", () => {
    expect(loadConfirmCopy("incompatible", false, "1.0.0", "1.4.0").detail).toBe(
      "File app version: 1.0.0\nCurrent app version: 1.4.0",
    );
    expect(loadConfirmCopy(null, true, undefined, "1.4.0").detail).toBeUndefined();
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
