// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { AppVersion } from "./app-version";

const ENV_KEY = "NEXT_PUBLIC_APP_VERSION";
const ORIGINAL_ENV = process.env[ENV_KEY];

afterEach(() => {
  cleanup();
  if (ORIGINAL_ENV === undefined) {
    delete process.env[ENV_KEY];
  } else {
    process.env[ENV_KEY] = ORIGINAL_ENV;
  }
});

describe("AppVersion badge", () => {
  it("prefixes a bare semver stamp with a single v", () => {
    process.env[ENV_KEY] = "0.1.1";
    render(<AppVersion />);
    expect(screen.getByTestId("app-version").textContent).toBe("v0.1.1");
  });

  it("does not double-prefix an already v-prefixed git-describe stamp", () => {
    process.env[ENV_KEY] = "v0.1.1-5-gabc1234";
    render(<AppVersion />);
    const el = screen.getByTestId("app-version");
    expect(el.textContent).toBe("v0.1.1-5-gabc1234");
    expect(el.textContent).not.toMatch(/vv/);
  });
});
