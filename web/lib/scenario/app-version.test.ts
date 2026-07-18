import { afterEach, describe, expect, it } from "vitest";
import { currentAppVersion } from "./app-version";

const ENV_KEY = "NEXT_PUBLIC_APP_VERSION";
const ORIGINAL_ENV = process.env[ENV_KEY];

afterEach(() => {
  if (ORIGINAL_ENV === undefined) {
    delete process.env[ENV_KEY];
  } else {
    process.env[ENV_KEY] = ORIGINAL_ENV;
  }
});

describe("currentAppVersion (build-stamp helper)", () => {
  it('falls back to "unknown" when NEXT_PUBLIC_APP_VERSION is unset', () => {
    delete process.env[ENV_KEY];
    expect(currentAppVersion()).toBe("unknown");
  });

  it("returns the stamped value verbatim when set", () => {
    process.env[ENV_KEY] = "1.2.3";
    expect(currentAppVersion()).toBe("1.2.3");
  });

  it("preserves a -dirty suffix exactly (no normalization)", () => {
    process.env[ENV_KEY] = "1.2.3-dirty";
    expect(currentAppVersion()).toBe("1.2.3-dirty");
  });
});
