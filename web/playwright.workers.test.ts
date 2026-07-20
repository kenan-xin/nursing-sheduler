import { describe, expect, it } from "vitest";
import packageJson from "./package.json";
import { DEFAULT_WORKER_CAP, resolveWorkerCount, WORKERS_ENV } from "./playwright.workers";

// Sensitive-config contract for the qq0.29 worker policy. These assertions are
// the guardrail that keeps the required release gate DETERMINISTIC and BOUNDED:
// if someone raises/removes the cap or lets the count scale unbounded with the
// host, the gate could pass locally yet fail massively on a large CI runner
// (the exact regression the audit reproduced). Breaking that must fail here.

describe("resolveWorkerCount — deterministic bounded worker policy", () => {
  it("caps at DEFAULT_WORKER_CAP on high-core hosts (unbounded scaling is the regression)", () => {
    // A 60-core host is where Playwright's own ceil(cpus/2)=30 default spawned
    // the oversubscription the audit traced to CPU-starvation timeouts.
    expect(resolveWorkerCount({ cpuCount: 60 })).toBe(DEFAULT_WORKER_CAP);
    expect(resolveWorkerCount({ cpuCount: 128 })).toBe(DEFAULT_WORKER_CAP);
    // The cap must stay conservative; a silent bump to a large value regresses.
    expect(DEFAULT_WORKER_CAP).toBeLessThanOrEqual(8);
  });

  it("uses floor(cpus/2) when that is under the cap (small hosts)", () => {
    expect(resolveWorkerCount({ cpuCount: 4 })).toBe(2);
    expect(resolveWorkerCount({ cpuCount: 8 })).toBe(4);
    // 32 cores → floor(16) but capped to DEFAULT_WORKER_CAP.
    expect(resolveWorkerCount({ cpuCount: 32 })).toBe(DEFAULT_WORKER_CAP);
  });

  it("never drops below one worker, even on a 1-core or bogus host", () => {
    expect(resolveWorkerCount({ cpuCount: 1 })).toBe(1);
    expect(resolveWorkerCount({ cpuCount: 0 })).toBe(1);
    expect(resolveWorkerCount({ cpuCount: Number.NaN })).toBe(1);
    expect(resolveWorkerCount({ cpuCount: -8 })).toBe(1);
  });

  it("honors a valid positive-integer override verbatim (stress-lane escape hatch)", () => {
    expect(resolveWorkerCount({ cpuCount: 32, override: "64" })).toBe(64);
    expect(resolveWorkerCount({ cpuCount: 32, override: "1" })).toBe(1);
    expect(resolveWorkerCount({ cpuCount: 4, override: "16" })).toBe(16);
  });

  it("ignores a malformed or non-positive override instead of yielding 0/NaN", () => {
    expect(resolveWorkerCount({ cpuCount: 32, override: "" })).toBe(DEFAULT_WORKER_CAP);
    expect(resolveWorkerCount({ cpuCount: 32, override: "  " })).toBe(DEFAULT_WORKER_CAP);
    expect(resolveWorkerCount({ cpuCount: 32, override: "0" })).toBe(DEFAULT_WORKER_CAP);
    expect(resolveWorkerCount({ cpuCount: 32, override: "-4" })).toBe(DEFAULT_WORKER_CAP);
    expect(resolveWorkerCount({ cpuCount: 32, override: "abc" })).toBe(DEFAULT_WORKER_CAP);
    expect(resolveWorkerCount({ cpuCount: 32, override: "4.5" })).toBe(DEFAULT_WORKER_CAP);
  });

  it("trims surrounding whitespace on an otherwise valid override", () => {
    expect(resolveWorkerCount({ cpuCount: 32, override: " 6 " })).toBe(6);
  });

  it("accepts an override right at MAX_SAFE_INTEGER but rejects anything above it", () => {
    const maxSafe = String(Number.MAX_SAFE_INTEGER); // "9007199254740991"
    expect(resolveWorkerCount({ cpuCount: 32, override: maxSafe })).toBe(Number.MAX_SAFE_INTEGER);
    // One past MAX_SAFE loses integer precision, so it must fall through to the
    // bounded default rather than pass a lossy value to Playwright.
    const overMaxSafe = String(Number.MAX_SAFE_INTEGER + 1); // "9007199254740992"
    expect(resolveWorkerCount({ cpuCount: 32, override: overMaxSafe })).toBe(DEFAULT_WORKER_CAP);
  });

  it("rejects a huge digit-only overflow override instead of trusting the lossy parse", () => {
    // 40 nines — well past MAX_SAFE; the digit-only regex admits it but the
    // safe-integer guard rejects it.
    const huge = "9".repeat(40);
    expect(resolveWorkerCount({ cpuCount: 32, override: huge })).toBe(DEFAULT_WORKER_CAP);
    // 1e300-scale magnitude expressed as plain digits.
    expect(resolveWorkerCount({ cpuCount: 32, override: `1${"0".repeat(300)}` })).toBe(
      DEFAULT_WORKER_CAP,
    );
  });

  it("exposes the documented override env-var name", () => {
    expect(WORKERS_ENV).toBe("PLAYWRIGHT_WORKERS");
  });
});

describe("test:e2e:stress command contract — portable across shells", () => {
  const stressScript = (packageJson as { scripts: Record<string, string> }).scripts[
    "test:e2e:stress"
  ];

  it("declares a stress lane", () => {
    expect(stressScript).toBeTruthy();
  });

  it("uses the portable Playwright `--workers` CLI flag, not a POSIX inline env assignment", () => {
    // Inline `PLAYWRIGHT_WORKERS=32 playwright test` is a POSIX-shell construct;
    // on Windows `cmd.exe` it tries to invoke a program literally named
    // `PLAYWRIGHT_WORKERS=32`. The `--workers=<n>` form runs identically on
    // every supported shell, so a regression back to the inline env prefix must
    // fail here.
    expect(stressScript).toMatch(/--workers=\d+/);
    expect(stressScript).not.toMatch(new RegExp(`(^|\\s)${WORKERS_ENV}=`));
  });

  it("pins the documented fixed high-parallelism count (32)", () => {
    // README describes the lane as a fixed 32-worker high-parallelism path; keep
    // the command and the docs in agreement.
    expect(stressScript).toMatch(/--workers=32(\s|$)/);
  });
});
