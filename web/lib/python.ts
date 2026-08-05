// Python toolchain resolver for the Python-sensitive web tests.
//
// The differential oracle (`lib/scenario/differential/oracle-client.ts`) and the
// `verify-deploy` parity corpus (`verify-deploy.test.ts`) shell out to a Python
// interpreter whose project support floor is Python 3.12 (matching
// `.mise.toml` / `.python-version` and the runtime image in
// `docker/Dockerfile.backend`). That floor subsumes the two transitive
// minimums the entrypoints actually need:
//   - `docker/validate_origin.py` — Python 3.10+ (PEP 604 unions)
//   - `web/lib/scenario/differential/oracle.py` — Python 3.10+ transitive
//     dependencies (pandas, openpyxl, pydantic).
// Previously both entrypoints fell back to a bare
// `process.env.PYTHON ?? "python3"`, so a shell whose ambient `python3` was
// not the project pin — e.g. the system `/usr/bin/python3` on macOS — either
// picked up a too-old interpreter (the verify-deploy corpus then exited 1 on
// every case because validate_origin.py refused to start) or a too-thin
// distribution (the differential then crashed on
// `ModuleNotFoundError: No module named 'pandas'`). The CI workflow is safe
// because it activates the mise toolchain via `jdx/mise-action@v2` before
// running the gates; local or automated callers running `pnpm test` outside an
// activated mise shell were not.
//
// Resolution contract (smallest robust repo-native mechanism):
//
//   1. If `process.env.PYTHON` is set, honor it verbatim. The override is the
//      ONE supported way to point these tests at a venv or wrapper script; the
//      differential self-tests rely on it (see oracle-client.test.ts). The
//      validator/oracle children fail closed on a bad interpreter, so we do not
//      re-probe its version here — honoring the override is the contract.
//
//   2. Otherwise, defer to the project mise pin. `mise which --cd <repoRoot>
//      python3` reads `.mise.toml` / `.python-version` from the worktree root
//      regardless of the caller's cwd, so the result is the same interpreter a
//      `mise exec -- pnpm test` invocation would have used. We pass `--cd`
//      explicitly because vitest's worker cwd may differ from the repo root.
//
//   3. If `mise which` itself fails (mise not installed, repo root missing
//      `.mise.toml`, python pin unconfigured), throw an actionable toolchain
//      error at MODULE LOAD. Both consumers import this module eagerly, so a
//      missing toolchain surfaces as a loud, named failure during vitest
//      collection — not as a silent skip or a per-test diff explosion later.
//
// The resolution is pure: tests can substitute `env` and `execFile` to exercise
// the override / mise / failure branches without depending on the host
// toolchain. The exported `PROJECT_PYTHON` is the resolved string under the
// real process environment and is what the test entrypoints consume.

import { execFileSync, type ExecFileSyncOptions } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// web/lib/python.ts → repo root is two parents up from `web/lib/`. Anchored to
// the file's own location (not cwd) so the resolution is identical whether the
// test was launched from the repo root, from `web/`, or from anywhere else.
const REPO_ROOT = join(HERE, "..", "..");

const PY_MIN_MAJOR = 3;
const PY_MIN_MINOR = 12;
// Settled project support floor (matches `.mise.toml` / `.python-version` and
// the runtime image). Surfaced verbatim in toolchain errors so the operator
// sees what the pin must provide. Do NOT regress this to 3.10/3.11: those
// transitive minimums are SUBSUMED by 3.12, and the fail-loud remediation
// copy is the contract a developer reads to fix their mise setup.
export const PY_MIN_VERSION = `${PY_MIN_MAJOR}.${PY_MIN_MINOR}`;

export interface ResolveProjectPythonOptions {
  /** Process env snapshot. Defaults to `process.env`. Tests pass a stub. */
  env?: NodeJS.ProcessEnv;
  /** execFile implementation. Defaults to Node's `execFileSync`. Tests stub it. */
  execFile?: typeof execFileSync;
  /** Repo root holding `.mise.toml` / `.python-version`. Defaults to the inferred location. */
  repoRoot?: string;
}

export type ResolutionSource = "override" | "mise";

export interface Resolution {
  /** Absolute path to the resolved interpreter, or the verbatim `PYTHON` override. */
  python: string;
  /** How `python` was chosen. */
  source: ResolutionSource;
}

function resolveViaMise(repoRoot: string, execFile: typeof execFileSync): string {
  // `--cd` pins mise's config lookup to the repo root regardless of the
  // worker's cwd; without it, launching vitest from an unrelated directory
  // would make mise search its ancestors and either find a stale `.mise.toml`
  // from a parent repo or fail outright. Capturing both stdout AND stderr is
  // intentional: a missing python pin typically writes its reason to stderr
  // and we surface the message in the throw below.
  //
  // The subprocess inherits the parent's PATH so the `mise` executable itself
  // can be located (and so mise can resolve its installed tool plugins). The
  // resolution still anchors to the repo root via `--cd`, so a stray shell
  // PATH cannot change which `.mise.toml` / `.python-version` is consulted —
  // only the binary lookup, which is the goal.
  const options: ExecFileSyncOptions = {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    cwd: repoRoot,
  };
  try {
    const stdout = execFile("mise", ["which", "--cd", repoRoot, "python3"], options) as string;
    return stdout.trim();
  } catch (error) {
    const stderr =
      error && typeof error === "object" && "stderr" in error
        ? String((error as { stderr?: unknown }).stderr ?? "").trim()
        : "";
    const reason = stderr || (error instanceof Error ? error.message : String(error));
    throw new Error(
      `Python toolchain unavailable: 'mise which --cd <repo> python3' failed (${reason}). ` +
        `Activate mise (root .mise.toml pins python ${PY_MIN_VERSION}+) or set PYTHON=<absolute path to a Python ${PY_MIN_VERSION}+ interpreter>.`,
    );
  }
}

/**
 * Resolve the Python interpreter the Python-sensitive web tests should use.
 *
 * Returns the path verbatim. Throws when no override is set AND the mise pin
 * cannot be resolved — that is the fail-loud toolchain contract. Override-only
 * paths are never re-validated; the validator/oracle children fail closed on
 * an unusable interpreter.
 */
export function resolveProjectPython(options: ResolveProjectPythonOptions = {}): Resolution {
  const env = options.env ?? process.env;
  const execFile = options.execFile ?? execFileSync;
  const repoRoot = options.repoRoot ?? REPO_ROOT;

  const override = env.PYTHON?.trim();
  if (override) {
    return { python: override, source: "override" };
  }

  const python = resolveViaMise(repoRoot, execFile);
  if (python === "") {
    throw new Error(
      `Python toolchain unavailable: 'mise which --cd <repo> python3' returned an empty path. ` +
        `Activate mise (root .mise.toml pins python ${PY_MIN_VERSION}+) or set PYTHON=<absolute path to a Python ${PY_MIN_VERSION}+ interpreter>.`,
    );
  }
  return { python, source: "mise" };
}

/** Resolved interpreter under the real process environment. Eagerly computed so a
 *  missing toolchain fails the import at collection time, not during a test. */
export const PROJECT_PYTHON_RESOLUTION: Resolution = resolveProjectPython();

/** Convenience: just the resolved interpreter path. The Python-sensitive entrypoints
 *  (verify-deploy.test.ts, oracle-client.ts) consume this string. */
export const PROJECT_PYTHON: string = PROJECT_PYTHON_RESOLUTION.python;
