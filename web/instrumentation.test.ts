import { afterEach, describe, expect, it, vi } from "vitest";
import { register } from "@/instrumentation";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function spyExit() {
  return vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
}

describe("instrumentation register (startup fail-fast)", () => {
  it("calls process.exit(1) on missing production config (nodejs runtime)", async () => {
    delete process.env.BACKEND_API_URL;
    delete process.env.PUBLIC_ORIGIN;
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("NODE_ENV", "production");
    const exit = spyExit();
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    await register();

    expect(exit).toHaveBeenCalledWith(1);
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("required in production"));
  });

  it("does not exit with valid production config", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BACKEND_API_URL", "http://backend:8000");
    vi.stubEnv("PUBLIC_ORIGIN", "https://nursescheduling.org");
    const exit = spyExit();

    await expect(register()).resolves.toBeUndefined();
    expect(exit).not.toHaveBeenCalled();
  });

  it("is a no-op outside the nodejs runtime (never validates or exits)", async () => {
    vi.stubEnv("NEXT_RUNTIME", "edge");
    vi.stubEnv("NODE_ENV", "production");
    const exit = spyExit();

    await expect(register()).resolves.toBeUndefined();
    expect(exit).not.toHaveBeenCalled();
  });
});
