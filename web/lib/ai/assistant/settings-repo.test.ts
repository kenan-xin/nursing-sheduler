import { describe, expect, it } from "vitest";

import { isAssistantReady, maskCredential } from "./records";
import {
  activateProbedConfiguration,
  readAssistantSettings,
  removeAssistantKey,
  setAssistantEnabled,
} from "./settings-repo";
import { SENTINEL_KEY, TEST_MODEL, createAssistantHarness, dumpDatabase } from "./test-support";

describe("assistant settings", () => {
  it("reads as OFF before anything has ever been written", async () => {
    const harness = createAssistantHarness();

    const settings = await readAssistantSettings(harness.config);

    expect(settings.enabled).toBe(false);
    expect(settings.apiKey).toBeNull();
    expect(settings.modelId).toBeNull();
    expect(isAssistantReady(settings)).toBe(false);
  });

  it("enabling alone does NOT make the assistant ready", async () => {
    const harness = createAssistantHarness();

    const settings = await setAssistantEnabled(true, harness.config);

    expect(settings.enabled).toBe(true);
    // The Configuring state: the toggle is on, but nothing has been probed, so
    // every surface and every send is still refused.
    expect(isAssistantReady(settings)).toBe(false);
  });

  it("becomes ready only once a probed pair is activated", async () => {
    const harness = createAssistantHarness();
    await setAssistantEnabled(true, harness.config);

    const settings = await activateProbedConfiguration(
      { apiKey: SENTINEL_KEY, modelId: TEST_MODEL, modelSource: "catalog" },
      harness.config,
    );

    expect(isAssistantReady(settings)).toBe(true);
    expect(settings?.probedAt).toBe(harness.now().toISOString());
  });

  it("writes the key and model together, so a mixed pair cannot exist", async () => {
    const harness = createAssistantHarness();
    await setAssistantEnabled(true, harness.config);
    await activateProbedConfiguration(
      { apiKey: "key-one", modelId: "vendor/one", modelSource: "catalog" },
      harness.config,
    );

    const replaced = await activateProbedConfiguration(
      { apiKey: "key-two", modelId: "vendor/two", modelSource: "custom" },
      harness.config,
    );

    expect(replaced?.apiKey).toBe("key-two");
    expect(replaced?.modelId).toBe("vendor/two");
    expect(replaced?.modelSource).toBe("custom");
  });

  it("leaves a working configuration untouched when a later probe is never activated", async () => {
    const harness = createAssistantHarness();
    await setAssistantEnabled(true, harness.config);
    await activateProbedConfiguration(
      { apiKey: SENTINEL_KEY, modelId: TEST_MODEL, modelSource: "catalog" },
      harness.config,
    );

    // A failed probe calls nothing at all -- which is the invariant: there is no
    // durable draft for it to disturb.
    const settings = await readAssistantSettings(harness.config);

    expect(settings.apiKey).toBe(SENTINEL_KEY);
    expect(settings.modelId).toBe(TEST_MODEL);
    expect(isAssistantReady(settings)).toBe(true);
  });

  it("removes the key immediately, keeps the model, and drops readiness", async () => {
    const harness = createAssistantHarness();
    await setAssistantEnabled(true, harness.config);
    await activateProbedConfiguration(
      { apiKey: SENTINEL_KEY, modelId: TEST_MODEL, modelSource: "catalog" },
      harness.config,
    );

    const settings = await removeAssistantKey(harness.config);

    expect(settings.apiKey).toBeNull();
    expect(settings.probedAt).toBeNull();
    // Retained deliberately: re-entering a key returns the user to their model.
    expect(settings.modelId).toBe(TEST_MODEL);
    expect(isAssistantReady(settings)).toBe(false);
    expect(settings.enabled).toBe(true);
  });

  it("disabling preserves the stored configuration for a later re-enable", async () => {
    const harness = createAssistantHarness();
    await setAssistantEnabled(true, harness.config);
    await activateProbedConfiguration(
      { apiKey: SENTINEL_KEY, modelId: TEST_MODEL, modelSource: "catalog" },
      harness.config,
    );

    await setAssistantEnabled(false, harness.config);
    const off = await readAssistantSettings(harness.config);
    expect(isAssistantReady(off)).toBe(false);
    expect(off.apiKey).toBe(SENTINEL_KEY);

    await setAssistantEnabled(true, harness.config);
    expect(isAssistantReady(await readAssistantSettings(harness.config))).toBe(true);
  });

  it("stores the credential in the settings row and NOWHERE else in the database", async () => {
    const harness = createAssistantHarness();
    await setAssistantEnabled(true, harness.config);
    await activateProbedConfiguration(
      { apiKey: SENTINEL_KEY, modelId: TEST_MODEL, modelSource: "catalog" },
      harness.config,
    );

    const dump = await dumpDatabase(harness.db);

    expect(dump.assistantSettings).toContain(SENTINEL_KEY);
    for (const [table, contents] of Object.entries(dump)) {
      if (table === "assistantSettings") continue;
      expect(contents, `${table} contains the credential`).not.toContain(SENTINEL_KEY);
    }
  });

  it("masks a credential down to a tail that cannot reconstruct it", () => {
    const masked = maskCredential(SENTINEL_KEY);
    expect(masked).not.toContain("SENTINEL");
    expect(masked?.endsWith("0001")).toBe(true);
    expect(maskCredential(null)).toBeNull();
  });
});
