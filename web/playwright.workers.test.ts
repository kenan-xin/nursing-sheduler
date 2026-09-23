import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import packageJson from "./package.json";
import focusedPlaywrightConfig from "./playwright.public-roster-dispatch.config";
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

describe("test:e2e:public-roster-dispatch command contract — gated focused public-Next dispatch", () => {
  const scripts = (packageJson as { scripts: Record<string, string> }).scripts;
  const dispatchScript = scripts["test:e2e:public-roster-dispatch"];

  it("declares the public-roster-dispatch lane", () => {
    expect(dispatchScript).toBeTruthy();
  });

  it("targets the focused playwright config (not the base config or a bare `playwright test`)", () => {
    // The base `playwright.config.ts` excludes this spec via `testIgnore` because
    // its `webServer` placeholder `BACKEND_API_URL=http://127.0.0.1:8000` would
    // collide with a developer's real FastAPI. The focused config reuses the same
    // `pnpm build && pnpm start` launcher but points the BFF at a private stub port.
    // A regression that drops `--config=...` would put the spec under the base
    // config (excluded) and silently skip the public-dispatch proof.
    expect(dispatchScript).toMatch(/--config=playwright\.public-roster-dispatch\.config\.ts(\s|$)/);
  });

  it("does NOT inline a backend URL/port or any POSIX env assignment (kept in the config)", () => {
    // Mirrors the `:stress` decision against `PLAYWRIGHT_WORKERS=32` inline env:
    // on Windows `cmd.exe` it would invoke a program literally named
    // `PUBLIC_ROSTER_TEST_BACKEND_PORT=8765`. The focused config owns the
    // backend URL/port so the script stays portable across shells.
    expect(dispatchScript).not.toMatch(new RegExp(`(^|\\s)[A-Z_]+=`, "u"));
    // And the script must not set `--workers`, so it cannot silently bypass the
    // focused config's `workers: 1` (which serializes the one stub backend).
    expect(dispatchScript).not.toMatch(/--workers=/);
  });
});

// Focused-config contract (B3 closure repair). The prior contract checked only
// the package-script STRING; it left green if `playwright.public-roster-dispatch
// .config.ts` was deleted, had its `testMatch` widened, pointed BACKEND_API_URL
// at the base 8000 placeholder, or dropped `workers: 1` / `reuseExistingServer:
// false`. The closure review's P1 was exactly that gap. This block imports the
// config module under Vitest (Vitest natively compiles `.ts`, and `@playwright/
// test`'s `defineConfig` returns a plain object), so each assertion executes
// against the REAL resolved config the focused script invokes — deleting the
// file, widening `testMatch`, or reverting isolation/freshServer now fails here
// before any browser job runs.
describe("playwright.public-roster-dispatch.config — focused-config invariants", () => {
  // `defineConfig` returns the resolved object; its `testMatch` RegExp selects
  // the spec by filename suffix anchored at `$`. Playwright resolves the
  // pattern against the file path relative to `testDir`, so a regex that matches
  // the spec's filename and nothing else proves focused selection.
  const config = focusedPlaywrightConfig as {
    testDir?: string;
    testMatch?: RegExp | string | string[];
    workers?: number;
    webServer?: {
      command?: string;
      url?: string;
      env?: Record<string, string>;
      reuseExistingServer?: boolean;
    };
  };

  it("the resolved config object is importable (the focused config file exists and parses)", () => {
    // A deleted or syntax-broken focused config fails this import, which fails
    // this top-level `describe` block — and therefore the unit gate.
    expect(config).toBeTruthy();
    expect(typeof config).toBe("object");
  });

  it("selects exactly the public-roster-dispatch spec (not the whole e2e suite)", () => {
    const { testMatch } = config;
    // `testMatch` is a RegExp here; support string/array forms too so a
    // well-meant refactor to those forms doesn't silently widen selection.
    const patterns: RegExp[] = [];
    if (testMatch instanceof RegExp) {
      patterns.push(testMatch);
    } else if (typeof testMatch === "string") {
      patterns.push(new RegExp(testMatch));
    } else if (Array.isArray(testMatch)) {
      // Element type is ambiguous to TS after the union narrowing; cast via
      // `unknown` so the `instanceof RegExp` check is allowed (a stringpath
      // element is the only other supported form).
      for (const raw of testMatch as Array<unknown>) {
        patterns.push(raw instanceof RegExp ? raw : new RegExp(String(raw)));
      }
    }
    expect(patterns.length, "testMatch must be a non-empty focused pattern").toBeGreaterThan(0);

    // Positive: the dispatch spec matches.
    for (const re of patterns)
      expect(re.test("optimize-public-roster-dispatch.spec.ts")).toBe(true);
    // Negative: the base set/specs do NOT match, so the focused lane stays scoped.
    for (const re of patterns) {
      expect(re.test("smoke.spec.ts")).toBe(false);
      expect(re.test("optimize-durable-stream.spec.ts")).toBe(false);
      expect(re.test("optimize-assembled-stream.spec.ts")).toBe(false);
    }
  });

  it("uses the dedicated loopback stub port (not the base 8000 placeholder) for BACKEND_API_URL", () => {
    // Recompute the expected backend URL with the same default + env-override
    // the config uses, so an environment-set `PUBLIC_ROSTER_TEST_BACKEND_PORT`
    // is honored rather than over-constrained.
    const backendPort = Number(process.env.PUBLIC_ROSTER_TEST_BACKEND_PORT) || 8765;
    const expected = `http://127.0.0.1:${backendPort}`;

    const env = config.webServer?.env;
    expect(env, "webServer.env must be declared").toBeTruthy();
    expect(env!.BACKEND_API_URL).toBe(expected);
    // Unconditional: the closure review's regression is "BACKEND_API_URL reverts
    // to the base placeholder `http://127.0.0.1:8000`". That must never match.
    expect(env!.BACKEND_API_URL).not.toBe("http://127.0.0.1:8000");
  });

  it("uses exactly one worker (serializes the single stub backend; no port race)", () => {
    expect(config.workers).toBe(1);
  });

  it("reuses NO existing server (forces a fresh pnpm build so a stale server cannot false-green)", () => {
    expect(config.webServer?.reuseExistingServer).toBe(false);
  });
});

// CI workflow contract (B3 closure repair). The closure review's P1 #1 was that
// the workflow itself was UNPARSEABLE YAML, so GitHub never loaded the focused
// step. This block loads `.github/workflows/ci.yml` with the standards-compliant
// `yaml` parser (a direct `web` dependency, ^2.9.0) and asserts the focused
// script is invoked AFTER the base e2e step in the same `e2e` job. It is not a
// general workflow parser — it asserts exactly the two targeted invariants the
// closure review named, against the resolved workflow object.
describe(".github/workflows/ci.yml — workflow parses and gates the focused script after base e2e", () => {
  // The web/ package sits inside the repo root (or the isolated worktree root,
  // which is a full checkout); one level up reaches the `.github/` directory.
  const repoRoot = resolve(__dirname, "..");
  const workflowPath = resolve(repoRoot, ".github", "workflows", "ci.yml");

  it("the workflow file is present and parses as valid YAML (closure P1 #1: was unparseable)", () => {
    // Re-asserts the P1 #1 fix at unit-test time: deleting the file or
    // re-introducing a `: ` plain-scalar hazard in any step name fails here.
    expect(existsSync(workflowPath), "workflow path resolved from web/").toBe(true);
    const doc = parse(readFileSync(workflowPath, "utf8"));
    expect(doc).toBeTruthy();
    expect(Object.keys(doc.jobs)).toEqual(expect.arrayContaining(["checks", "e2e"]));
  });

  it("the `e2e` job invokes `pnpm test:e2e:public-roster-dispatch` AFTER the base `pnpm exec playwright test`", () => {
    // Order in the resolved step list must reflect the intended sequential
    // execution: a fresh developer-machine run and a CI run both must execute
    // the base gate first (its `webServer` builds and tears down), THEN the
    // focused gate (its `reuseExistingServer: false` rebuilds cleanly).
    const doc = parse(readFileSync(workflowPath, "utf8"));
    const steps = (doc.jobs.e2e.steps as Array<{ name?: string; run?: string }>) ?? [];
    const runSteps = steps
      .map((step, index) => ({ index, run: step.run ?? "" }))
      .filter((s) => s.run.length > 0);

    const baseStep = runSteps.find((s) => s.run === "pnpm exec playwright test");
    const focusedStep = runSteps.find((s) => s.run === "pnpm test:e2e:public-roster-dispatch");

    expect(baseStep, "base `pnpm exec playwright test` step exists").toBeDefined();
    expect(focusedStep, "focused `pnpm test:e2e:public-roster-dispatch` step exists").toBeDefined();
    // Sequential ordering: the focused step must come AFTER the base step. A
    // reordering that runs the focused gate before the base one (or removes the
    // base one and renumbers) makes the build-overlap guarantee disappear.
    expect(focusedStep!.index).toBeGreaterThan(baseStep!.index);
  });
});
