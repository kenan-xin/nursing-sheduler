// Tests for the Python toolchain resolver (`@/lib/python`).
//
// The resolver is the single point of interpreter selection for the
// Python-sensitive web tests: `verify-deploy.test.ts` (validate_origin.py) and
// `lib/scenario/differential/oracle-client.ts` (oracle.py). Without it, both
// callers fall back to ambient `python3`, which on a host whose system Python
// is older than the project pin (or simply lacks pandas / openpyxl) either
// flips the validator corpus green-by-exit-1 or crashes the differential on
// `ModuleNotFoundError`. These tests pin the three behaviors the contract
// requires:
//
//   1. `PYTHON` env override is honored verbatim and mise is NOT consulted.
//   2. With no override, the project mise pin is resolved via
//      `mise which --cd <repo> python3`.
//   3. A missing toolchain (no override AND mise unavailable) fails LOUDLY
//      at module load with an actionable error, not silently.
//
// The pure resolver is tested with injected `env` and `execFile`, so the
// override / mise / failure branches are exercised without depending on the
// host's mise availability. The exported `PROJECT_PYTHON` constant is tested
// for end-to-end correctness against the real toolchain: its resolved path
// must match the project pin AND actually be a working Python 3.12+ (the
// settled project support floor — NOT 3.10, which is only the transitive
// minimum for the validator's PEP 604 unions).

import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PROJECT_PYTHON,
  PROJECT_PYTHON_RESOLUTION,
  PY_MIN_VERSION,
  resolveProjectPython,
} from "@/lib/python";

const ORIGINAL_PYTHON = process.env.PYTHON;

/** Restore the env after each test; this file mutates `process.env.PYTHON` to
 *  exercise the override / unset branches and must not leak into sibling tests. */
afterEach(() => {
  if (ORIGINAL_PYTHON === undefined) {
    delete process.env.PYTHON;
  } else {
    process.env.PYTHON = ORIGINAL_PYTHON;
  }
});

describe("resolveProjectPython — override contract", () => {
  it("honors an explicit PYTHON override without invoking mise", () => {
    process.env.PYTHON = "/opt/venv/bin/python3.12";
    const execFile = vi.fn();
    const result = resolveProjectPython({ env: process.env, execFile });
    expect(result).toEqual({ python: "/opt/venv/bin/python3.12", source: "override" });
    expect(execFile).not.toHaveBeenCalled();
  });

  it("trims surrounding whitespace from the PYTHON override", () => {
    process.env.PYTHON = "   /opt/venv/bin/python3.12   ";
    const execFile = vi.fn();
    const result = resolveProjectPython({ env: process.env, execFile });
    expect(result.python).toBe("/opt/venv/bin/python3.12");
    expect(execFile).not.toHaveBeenCalled();
  });

  it("treats an empty or whitespace-only PYTHON as no override", () => {
    process.env.PYTHON = "   ";
    const execFile = vi.fn().mockReturnValue("/mise/python3\n");
    const result = resolveProjectPython({ env: process.env, execFile, repoRoot: "/repo" });
    expect(result).toEqual({ python: "/mise/python3", source: "mise" });
  });
});

describe("resolveProjectPython — mise fallback", () => {
  it("resolves via `mise which --cd <repo> python3` when PYTHON is unset", () => {
    delete process.env.PYTHON;
    const execFile = vi.fn().mockReturnValue("/mise/installs/python/3.12.13/bin/python3\n");
    const result = resolveProjectPython({
      env: process.env,
      execFile,
      repoRoot: "/worktrees/repo",
    });
    expect(result).toEqual({
      python: "/mise/installs/python/3.12.13/bin/python3",
      source: "mise",
    });
    expect(execFile).toHaveBeenCalledTimes(1);
    const [command, args, options] = execFile.mock.calls[0];
    expect(command).toBe("mise");
    expect(args).toEqual(["which", "--cd", "/worktrees/repo", "python3"]);
    expect(options.cwd).toBe("/worktrees/repo");
    // The subprocess inherits the parent's PATH so the `mise` executable and
    // its plugin python can be located; the repo-root `--cd` is what scopes
    // which `.mise.toml` / `.python-version` is consulted, not the env.
    expect(options.env).toBeUndefined();
  });

  it("fails loudly with an actionable toolchain error when mise is unavailable", () => {
    delete process.env.PYTHON;
    const execFile = vi.fn().mockImplementation(() => {
      throw new Error("spawn mise ENOENT");
    });
    expect(() =>
      resolveProjectPython({ env: process.env, execFile, repoRoot: "/worktrees/repo" }),
    ).toThrow(/Python toolchain unavailable/);
    expect(() =>
      resolveProjectPython({ env: process.env, execFile, repoRoot: "/worktrees/repo" }),
    ).toThrow(/PYTHON=/);
    // Names the version floor so the operator sees what the contract requires.
    expect(() =>
      resolveProjectPython({ env: process.env, execFile, repoRoot: "/worktrees/repo" }),
    ).toThrow(new RegExp(`Python ${PY_MIN_VERSION}\\+`));
    // The remediation copy must NEVER recommend a 3.10 or 3.11 interpreter,
    // even though validate_origin.py's transitive minimum is 3.10 (PEP 604)
    // and oracle.py's deps only need 3.10+ transitively. Those minimums are
    // subsumed by 3.12 — the settled project support floor — and the
    // fail-loud message is the contract a developer reads to fix their mise
    // setup. Rejecting stale copy keeps a future regression from rolling the
    // floor back to 3.10/3.11 silently.
    let thrown: Error | null = null;
    try {
      resolveProjectPython({ env: process.env, execFile, repoRoot: "/worktrees/repo" });
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).not.toBeNull();
    const remediation = thrown!.message;
    expect(remediation).not.toMatch(/Python 3\.10/);
    expect(remediation).not.toMatch(/Python 3\.11/);
    expect(remediation).toMatch(new RegExp(`Python ${PY_MIN_VERSION}\\+`));
  });

  it("includes mise's stderr in the toolchain error so the cause survives", () => {
    delete process.env.PYTHON;
    const execFile = vi.fn().mockImplementation(() => {
      const error = new Error("Command failed: mise which --cd /repo python3");
      Object.assign(error, { stderr: "python3 is a mise bin however it is not currently active" });
      throw error;
    });
    expect(() => resolveProjectPython({ env: process.env, execFile, repoRoot: "/repo" })).toThrow(
      /not currently active/,
    );
  });

  it("fails loudly when mise returns an empty path", () => {
    delete process.env.PYTHON;
    const execFile = vi.fn().mockReturnValue("   \n");
    expect(() => resolveProjectPython({ env: process.env, execFile, repoRoot: "/repo" })).toThrow(
      /empty path/,
    );
  });
});

// Project support floor — locked at Python 3.12 (the settled decision that
// `nursing-sheduler-3kl.1` aligned the resolver to). The cold review flagged
// that the previous floor (3.10) was transitive-only and let the fail-loud
// remediation copy recommend an unsupported interpreter. These assertions
// pin the constant AND reject any drift back to 3.10 or 3.11 in the
// remediation copy, so a future regression that lowers the floor would fail
// here rather than silently shipping.
describe("PY_MIN_VERSION — project support floor", () => {
  it("is exactly '3.12' (the settled project support floor)", () => {
    expect(PY_MIN_VERSION).toBe("3.12");
  });

  it("is never silently rolled back to a 3.10 or 3.11 minimum", () => {
    // Belt-and-braces: pin every plausible regression target. If someone
    // changes the constant to 3.10 or 3.11 to "loosen" the floor, this
    // catches it. The constant is the single source of truth — no separate
    // `PY_MIN_MAJOR` / `PY_MIN_MINOR` constants to keep in sync, but a typo
    // in either would surface here. The exact `3.12` assertion above is the
    // primary contract; this test exists to make a regression to 3.10/3.11
    // fail with a more specific diagnostic than the generic "not 3.12" one.
    expect(PY_MIN_VERSION).not.toBe("3.10");
    expect(PY_MIN_VERSION).not.toBe("3.11");
    expect(PY_MIN_VERSION.startsWith("3.")).toBe(true);
  });

  it("is the version named in the fail-loud toolchain remediation copy", () => {
    // The fail-loud error is the contract a developer reads to fix their
    // mise setup. It MUST name the settled project floor (3.12) so a mise
    // setup supplying 3.10 or 3.11 is correctly told to upgrade, not
    // validated by the remediation.
    delete process.env.PYTHON;
    const execFile = vi.fn().mockImplementation(() => {
      throw new Error("spawn mise ENOENT");
    });
    let thrown: Error | null = null;
    try {
      resolveProjectPython({ env: process.env, execFile, repoRoot: "/worktrees/repo" });
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).not.toBeNull();
    const message = thrown!.message;
    expect(message).toContain(`Python ${PY_MIN_VERSION}+`);
    // Reject every plausible stale phrasing. These are the exact patterns
    // the cold review surfaced: 3.10 and 3.11 were the previous
    // transitive-only minimums and would re-validate an interpreter the
    // project does not actually support.
    expect(message).not.toMatch(/Python 3\.10/);
    expect(message).not.toMatch(/Python 3\.11/);
    expect(message).not.toMatch(/3\.10\+/);
    expect(message).not.toMatch(/3\.11\+/);
  });
});

// `PROJECT_PYTHON` and `PROJECT_PYTHON_RESOLUTION` are eagerly evaluated at
// module load — by the time this test runs, the resolver has already run
// against the real process environment. These assertions pin what that real
// resolution produced, against the project pin. They are SKIPPED (not failed)
// if the host has no mise on PATH, because the contract is that the resolver
// ITSELF throws in that case (verified above); there is no other way to assert
// the module-load behavior from inside a test that already imported the
// module successfully.
describe("PROJECT_PYTHON — module-load contract", () => {
  it("is a non-empty absolute path", () => {
    expect(typeof PROJECT_PYTHON).toBe("string");
    expect(PROJECT_PYTHON.length).toBeGreaterThan(0);
    expect(PROJECT_PYTHON.startsWith("/")).toBe(true);
  });

  it.runIf(realMiseAvailable())("resolves to the project pin under the real mise toolchain", () => {
    // The module-load `PROJECT_PYTHON_RESOLUTION` honors an explicit `PYTHON`
    // override when set, and otherwise resolves via `mise which --cd <repo>
    // python3`. Only the latter path is what this assertion pins — when an
    // override is present, the source is `override` and the override contract
    // above already covers the verbatim-path behavior. Skip under override so
    // this test stays focused on the contract it is about: the mise pin is
    // reachable and matches the resolver's output.
    if (process.env.PYTHON?.trim()) return;
    expect(PROJECT_PYTHON_RESOLUTION.source).toBe("mise");
    // web/lib/python.test.ts → repo root is two parents up from `web/lib/`.
    const repoRoot = dirname(dirname(new URL(import.meta.url).pathname));
    const fromMise = execFileSync("mise", ["which", "--cd", repoRoot, "python3"], {
      encoding: "utf-8",
    }).trim();
    expect(PROJECT_PYTHON).toBe(fromMise);
  });

  it.runIf(realMiseAvailable())("is an executable that reports a Python 3.12+ version", () => {
    const versionOutput = execFileSync(
      PROJECT_PYTHON,
      [
        "-c",
        "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}')",
      ],
      { encoding: "utf-8" },
    ).trim();
    const [majorStr, minorStr] = versionOutput.split(".");
    const major = Number(majorStr);
    const minor = Number(minorStr);
    expect(Number.isInteger(major)).toBe(true);
    expect(Number.isInteger(minor)).toBe(true);
    // The version floor is the project support floor, derived from
    // `PY_MIN_VERSION` so a future bump (e.g. 3.13, 3.14) updates the
    // assertion without manual edits. Hard-coding 12 here would silently
    // accept a regressed interpreter.
    const [minMajorStr, minMinorStr] = PY_MIN_VERSION.split(".");
    const minMajor = Number(minMajorStr);
    const minMinor = Number(minMinorStr);
    expect(
      major > minMajor || (major === minMajor && minor >= minMinor),
      `PROJECT_PYTHON ${PROJECT_PYTHON} reports ${versionOutput}, expected ${PY_MIN_VERSION}+`,
    ).toBe(true);
  });
});

function realMiseAvailable(): boolean {
  try {
    execFileSync("mise", ["--version"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}
