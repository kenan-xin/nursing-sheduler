import { describe, expect, it } from "vitest";
import { prepareScenarioLoad } from "@/lib/scenario";
import { buildSampleScenarioYaml, versionMismatchCopy } from "./load-controls-core";

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

  it("incompatible — verbatim byte-for-byte text, including the embedded paragraph breaks", () => {
    const { description } = versionMismatchCopy("incompatible", "1.0.0", "1.4.0");
    expect(description).toBe(
      "App version mismatch detected.\n\n" +
        "File app version: 1.0.0\n" +
        "Current app version: 1.4.0\n\n" +
        "Older YAML may not work after breaking changes, though we try to preserve compatibility. " +
        "If nothing breaks, you can continue.",
    );
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
