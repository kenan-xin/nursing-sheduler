import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { describe, expect, it } from "vitest";

// End-to-end proof that invalid BFF config makes the REAL standalone server
// process-fatal (not a live 500-serving process). Requires a prior `next build`
// (produces `.next/standalone/server.js`); skipped with a note when absent so it
// never silently "passes" without the artifact.
//
// PLATFORM BOUNDARY: ownership is proven from the PARENT via Linux `/proc`
// (see `pidOwnsSelectedPort`). That evidence is dependency-free but Linux-only.
// On any other platform we cannot prove socket ownership without an external
// dependency, so this whole suite is SKIPPED rather than falling back to a
// weaker signal (e.g. trusting child-originated stdout/IPC, which the child can
// forge). `IS_LINUX` gates every `describe`.
//
// Isolation + ownership + teardown:
//
//   • Per-case ports come from `reserveEphemeralPort()` — `listen(0, "127.0.0.1")`
//     then close, so no fixed-port contention under Vitest parallelism.
//
//     KNOWN RACE: between the reservation `close()` and the child's `listen()`,
//     the OS may rebind the port to another process. Nothing the child SAYS is
//     trusted to prove ownership — an arbitrary child can print the exact
//     `✓ Ready in 1ms` banner and send any IPC-shaped payload without ever
//     binding. Instead ownership is OBSERVED FROM THE PARENT against the kernel:
//     `pidOwnsSelectedPort(pid, port)` reads `/proc/net/tcp` and
//     `/proc/net/tcp6`, collects the inode(s) of the socket(s) in state LISTEN
//     (0x0A) on the selected port, then confirms the spawned PID links one of
//     those inodes as a `socket:[inode]` entry under `/proc/<pid>/fd`. Only the
//     process that actually holds the listening socket passes. A stale holder
//     from a prior run, an unrelated responder that merely owns the port, or a
//     child that forges the marker without binding all fail — the child is never
//     asked to authenticate itself.
//
//   • Readiness = four-way AND:
//       (1) the spawned PID actually holds the LISTEN socket on the selected
//           port, per parent-observed `/proc` correlation (the authoritative,
//           unforgeable ownership proof);
//       (2) HTTP 200 from `GET /` (an explicitly chosen app-level response;
//           not a generalized Next.js readiness contract);
//       (3) the spawned child's stdout has yielded the full `✓ Ready in <N>(ms|s)`
//           event (buffered, ANSI-tolerant) — retained as an additional
//           diagnostic condition, never as the ownership signal on its own;
//       (4) the child process is still alive at probe time.
//
//   • Probes run on a serialized async loop (one at a time, every
//     PROBE_INTERVAL_MS). Each probe carries its own AbortController tracked in
//     an `activeProbes` set so finish() can abort and drain every one.
//
//   • finish() is the SINGLE idempotent resolve path. Before the outer promise
//     resolves it: clears the ready timer, aborts and drains every probe, SIGKILLs
//     the child if still alive, and AWAITS three explicit settle signals — child
//     `close`, stdout `end`, stderr `end` — each via a CANCELLABLE bounded wait
//     that clears its fallback timer the instant the real signal wins and tracks
//     every still-pending fallback in `pendingWatchdogs`. A bound that wins is
//     reported as `cleanupComplete: false` (failing the test); on success every
//     watchdog timer is cleared, so `pendingWatchdogsAtResolve` is 0. The success
//     path therefore carries proof, not a timer race, and leaks no timer.
const SERVER = path.resolve(process.cwd(), ".next/standalone/server.js");
// Parent-observed socket ownership reads Linux `/proc`; gate the suite on it.
const IS_LINUX = process.platform === "linux";
const hasBuild = existsSync(SERVER);
const canRun = IS_LINUX && hasBuild;
const STDOUT_LIMIT = 8 * 1024;
const STDERR_LIMIT = 8 * 1024;
const READY_TAIL_BUFFER_LIMIT = 4 * 1024;
const PROBE_INTERVAL_MS = 200;
const PROBE_TIMEOUT_MS = 1_500;
const READY_TIMEOUT_MS = 8_000;
// Hard upper bound on ANY individual settle signal. The success path completes
// in tens of milliseconds; this ceiling exists solely to keep a pathological
// platform failure visible instead of hanging the test forever. When it wins
// the race, `cleanupComplete` is reported false and the test fails.
const SETTLE_HARD_BOUND_MS = 5_000;
// Full post-bind readiness event: `✓ Ready in <N>(ms|s)`. The literal `✓` and
// the unit (`ms` or `s`) are part of the signal — a stale or arbitrary chunk
// containing `Ready` alone cannot match.
/* oxlint-disable no-control-regex -- the ESC (0x1b) bytes below are the ANSI framing we intentionally tolerate/strip */
const READY_EVENT_RE =
  /(?:^|\r?\n)\s*(?:\u001b\[[0-9;?]*[ -/]*[@-~])*\s*✓\s*Ready\s+in\s+\d+\s*(?:ms|s)\b/;
const ANSI_ESCAPE_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
/* oxlint-enable no-control-regex */

// ---- parent-observed Linux `/proc` socket ownership ----
//
// The kernel is the authority on who holds a listening socket. We read it
// directly from the parent, so the spawned child cannot influence the verdict.
//
// `/proc/net/tcp` and `/proc/net/tcp6` list one row per TCP socket. Columns
// (whitespace-separated, after the header) are:
//   sl  local_address rem_address st ... inode ...
//     • col[1] `local_address` = `HEXIP:HEXPORT` (port is the 4 hex digits after
//       the last `:`);
//     • col[3] `st` = connection state, `0A` == LISTEN;
//     • col[9] `inode` = the socket's inode number.
// We collect the inode of every LISTEN row whose local port equals the selected
// port. Then, under `/proc/<pid>/fd`, each entry is a symlink; a socket fd links
// to `socket:[<inode>]`. If the spawned PID links any of the collected LISTEN
// inodes, that PID is the actual owner of the listening socket on that port.

/** Parse one `/proc/net/tcp*` file; return inodes of LISTEN sockets on `port`. */
function listenInodesForPort(procNetPath: string, port: number): Set<string> {
  const inodes = new Set<string>();
  let content: string;
  try {
    content = readFileSync(procNetPath, "utf8");
  } catch {
    // The v6 table may be absent on some kernels; treat as no matches.
    return inodes;
  }
  const lines = content.split("\n");
  // lines[0] is the header row.
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].trim().split(/\s+/);
    // Need at least through the inode column (index 9).
    if (cols.length < 10) continue;
    if (cols[3] !== "0A") continue; // not LISTEN
    const local = cols[1];
    const colon = local.lastIndexOf(":");
    if (colon === -1) continue;
    const hexPort = local.slice(colon + 1);
    if (Number.parseInt(hexPort, 16) !== port) continue;
    inodes.add(cols[9]);
  }
  return inodes;
}

/** Collect the socket inodes referenced by `/proc/<pid>/fd/*` symlinks. */
function pidSocketInodes(pid: number): Set<string> {
  const inodes = new Set<string>();
  let entries: string[];
  try {
    entries = readdirSync(`/proc/${pid}/fd`);
  } catch {
    // Process gone, or fd dir unreadable — no owned sockets observable.
    return inodes;
  }
  for (const entry of entries) {
    try {
      const target = readlinkSync(`/proc/${pid}/fd/${entry}`);
      const match = /^socket:\[(\d+)\]$/.exec(target);
      if (match) inodes.add(match[1]);
    } catch {
      // fd can vanish between readdir and readlink; skip it.
    }
  }
  return inodes;
}

/**
 * Parent-observed ownership: does the spawned PID actually hold the LISTEN
 * socket on `port`? True only when a LISTEN inode for that port (from either
 * the v4 or v6 table) is linked under `/proc/<pid>/fd`.
 */
function pidOwnsSelectedPort(pid: number, port: number): boolean {
  const listenInodes = new Set<string>([
    ...listenInodesForPort("/proc/net/tcp", port),
    ...listenInodesForPort("/proc/net/tcp6", port),
  ]);
  if (listenInodes.size === 0) return false;
  const fdInodes = pidSocketInodes(pid);
  for (const inode of listenInodes) {
    if (fdInodes.has(inode)) return true;
  }
  return false;
}

interface Outcome {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  becameServiceable: boolean;
  reason: string;
  diagnostics: string;
  childPid: number | undefined;
  cleanupComplete: boolean;
  cleanupIncompleteReason?: string;
  closeObserved: boolean;
  stdoutSettled: boolean;
  stderrSettled: boolean;
  activeProbesAtResolve: number;
  /**
   * The spawned PID was observed (from the parent, via `/proc`) to actually
   * hold the LISTEN socket on the selected port at readiness time.
   */
  ownsSelectedPort: boolean;
  /** Fallback watchdog timers still scheduled when the helper resolved. */
  pendingWatchdogsAtResolve: number;
  /** Inter-probe delay timers still scheduled when the helper resolved. */
  probeDelayWorkAtResolve: number;
}

// Bind a `127.0.0.1` listener on port 0, capture the OS-assigned port, then
// release it. The returned number is what the OS handed US — not a guarantee
// the standalone server will land on the same port (see KNOWN RACE above).
async function reserveEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

interface RunOptions {
  env?: Record<string, string | undefined>;
  port: number;
  /** Override the script the helper would otherwise spawn as the server. */
  serverPath?: string;
  /** Override the spawn command. Default `process.execPath` (node). */
  command?: string;
  /** Override the spawn args. Default `[serverPath]`. */
  args?: string[];
  /** Override the spawn cwd. Default `path.dirname(serverPath)`. */
  cwd?: string;
  timeoutMs?: number;
}

interface CleanupPaths {
  /**
   * Resolves with the child's terminal `close` payload — the last lifecycle
   * event Node emits, after `exit` and after the stdio streams close.
   */
  childClosedResult: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** Resolves when the child's stdout has emitted `end` (or `close`/`error`). */
  stdoutDrained: Promise<void>;
  /** Resolves when the child's stderr has emitted `end` (or `close`/`error`). */
  stderrDrained: Promise<void>;
}

function attachSettleSignals(child: ChildProcess): CleanupPaths {
  const childClosedResult = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const waitStreamEnd = (stream: NodeJS.ReadableStream | null): Promise<void> =>
    new Promise((resolve) => {
      if (!stream) {
        resolve();
        return;
      }
      let done = false;
      const settle = (): void => {
        if (done) return;
        done = true;
        resolve();
      };
      stream.once("end", settle);
      stream.once("close", settle);
      stream.once("error", settle);
    });
  return {
    childClosedResult,
    stdoutDrained: waitStreamEnd(child.stdout),
    stderrDrained: waitStreamEnd(child.stderr),
  };
}

function runServer(opts: RunOptions): Promise<Outcome> {
  const {
    env: envIn,
    port,
    serverPath = SERVER,
    command = process.execPath,
    args = [serverPath],
    cwd = path.dirname(serverPath),
    timeoutMs = READY_TIMEOUT_MS,
  } = opts;
  const env: Record<string, string | undefined> = envIn ?? { ...process.env };
  const startedAt = Date.now();

  let stdout = "";
  let stderr = "";
  let stdoutTruncated = false;
  let stderrTruncated = false;
  const probes: string[] = [];

  const appendBounded = (target: "stdout" | "stderr", chunk: string): void => {
    let buf = target === "stdout" ? stdout : stderr;
    let truncated = target === "stdout" ? stdoutTruncated : stderrTruncated;
    if (truncated) return;
    const limit = target === "stdout" ? STDOUT_LIMIT : STDERR_LIMIT;
    if (buf.length + chunk.length > limit) {
      buf = `${(buf + chunk).slice(0, limit)}\n[... truncated ...]`;
      truncated = true;
    } else {
      buf += chunk;
    }
    if (target === "stdout") {
      stdout = buf;
      stdoutTruncated = truncated;
    } else {
      stderr = buf;
      stderrTruncated = truncated;
    }
  };

  let resolveOuter: (o: Outcome) => void = () => {};
  const outer = new Promise<Outcome>((r) => {
    resolveOuter = r;
  });

  let settled = false;
  let becameServiceable = false;
  let readyMarkerEmittedAt: number | null = null;
  // DIAGNOSTIC ONLY. Records the first time parent-observed `/proc` correlation
  // confirmed the spawned PID held the LISTEN socket on the selected port. It is
  // never consulted for the readiness decision — a stale positive must not
  // authorize a later probe (the child could bind, get observed, then release
  // the port to an unrelated responder). Ownership is recomputed FRESH inside
  // every candidate probe and only that current result decides readiness.
  let ownsPortObservedAt: number | null = null;
  let timer: NodeJS.Timeout | undefined;
  // Spawn-time failure (binary not found etc.). On such a failure Node emits
  // `error` then `close` (never `exit`), so we capture it here and drive the
  // single finish path from the error handler registered below.
  let spawnError: Error | null = null;

  const child: ChildProcess = spawn(command, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...env,
      PORT: String(port),
      HOSTNAME: "127.0.0.1",
    } as unknown as NodeJS.ProcessEnv,
  });

  // Buffered stdout scan for the post-bind readiness event. We use a
  // StringDecoder so multi-byte UTF-8 (`✓` is 3 bytes) is preserved across
  // chunk boundaries, and the regex requires the full `✓ Ready in N(ms|s)`
  // event — not a bare `Ready` substring — so unrelated application output
  // cannot satisfy ownership.
  const stdoutDecoder = new StringDecoder("utf8");
  let readyTailBuffer = "";
  child.stdout?.on("data", (chunk: unknown) => {
    const text = typeof chunk === "string" ? chunk : stdoutDecoder.write(chunk as Buffer);
    appendBounded("stdout", text);
    if (readyMarkerEmittedAt !== null) return;
    if (text.length === 0) return;
    readyTailBuffer = `${readyTailBuffer}${text}`.slice(-READY_TAIL_BUFFER_LIMIT);
    const stripped = readyTailBuffer.replace(ANSI_ESCAPE_RE, "");
    if (READY_EVENT_RE.test(stripped)) {
      readyMarkerEmittedAt = Date.now();
    }
  });
  child.stdout?.on("end", () => {
    const tail = stdoutDecoder.end();
    if (tail) appendBounded("stdout", tail);
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => appendBounded("stderr", chunk));

  const { childClosedResult, stdoutDrained, stderrDrained } = attachSettleSignals(child);

  const childAlive = (): boolean => child.exitCode === null && child.signalCode === null;

  // ---- probes (serialized; each tracked + bounded) ----
  type ProbeHandle = {
    controller: AbortController;
    promise: Promise<void>;
  };
  const activeProbes = new Set<ProbeHandle>();

  const probeOnce = async (controller: AbortController, onReady: () => void): Promise<void> => {
    const tHandle = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      if (!childAlive()) {
        probes.push(
          `t+${Date.now() - startedAt}ms: skipped (child gone, exit=${child.exitCode} signal=${child.signalCode})`,
        );
        return;
      }
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        signal: controller.signal,
        redirect: "manual",
      });
      try {
        await res.text();
      } catch {
        // Body may already be aborted or closed; nothing to do.
      }
      const marker = readyMarkerEmittedAt;
      // Parent-observed ownership: recompute FRESH from the kernel for THIS
      // probe, after the HTTP response and immediately before the readiness
      // decision. Never reuse a prior positive — a child that was observed
      // owning the port earlier may have since released it to an unrelated
      // responder. Record the first positive timestamp for diagnostics only.
      const pid = child.pid;
      const ownsPortNow = typeof pid === "number" && pidOwnsSelectedPort(pid, port);
      if (ownsPortNow && ownsPortObservedAt === null) {
        ownsPortObservedAt = Date.now();
      }
      // Re-confirm liveness at the decision point (after the /proc read).
      const alive = childAlive();
      if (ownsPortNow && res.status === 200 && marker !== null && alive) {
        becameServiceable = true;
        onReady();
        return;
      }
      probes.push(
        `t+${Date.now() - startedAt}ms: status=${res.status} ownsPortNow=${ownsPortNow} readyMarker=${marker !== null} alive=${alive}`,
      );
    } catch (err) {
      if (controller.signal.aborted) return;
      const msg = err instanceof Error ? err.message : String(err);
      probes.push(`t+${Date.now() - startedAt}ms: ${msg.slice(0, 120)}`);
    } finally {
      clearTimeout(tHandle);
    }
  };

  // Inter-probe delay work, tracked so finish() can cancel and settle it. Each
  // wait registers its timer here; the resolver is retained so finish() can
  // clear the timer AND resolve the awaiting `probeLoop` immediately instead of
  // leaking a pending 200ms timer past resolution. On every path this set is
  // empty at resolve time (asserted via `probeDelayWorkAtResolve`).
  const pendingProbeDelays = new Set<NodeJS.Timeout>();
  const probeDelayResolvers = new Set<() => void>();
  const interProbeDelay = (): Promise<void> =>
    new Promise((resolve) => {
      // If finish already ran, don't schedule any new delay work.
      if (settled) {
        resolve();
        return;
      }
      let done = false;
      const settleDelay = (): void => {
        if (done) return;
        done = true;
        clearTimeout(timerHandle);
        pendingProbeDelays.delete(timerHandle);
        probeDelayResolvers.delete(settleDelay);
        resolve();
      };
      const timerHandle = setTimeout(settleDelay, PROBE_INTERVAL_MS);
      pendingProbeDelays.add(timerHandle);
      probeDelayResolvers.add(settleDelay);
    });
  const cancelInterProbeDelays = (): void => {
    // Snapshot then settle: each resolver clears its own timer and deregisters.
    for (const resolve of Array.from(probeDelayResolvers)) resolve();
  };

  let probeBusy = false;
  const probeLoop = async (): Promise<void> => {
    while (!settled) {
      if (!probeBusy) {
        probeBusy = true;
        const controller = new AbortController();
        const handle: ProbeHandle = {
          controller,
          promise: Promise.resolve(),
        };
        activeProbes.add(handle);
        const promise = probeOnce(controller, () => {
          void finish("serviceable");
        }).finally(() => {
          activeProbes.delete(handle);
          probeBusy = false;
        });
        handle.promise = promise;
        await promise;
      }
      if (settled) break;
      await interProbeDelay();
    }
  };

  // ---- finish: the SINGLE idempotent resolve path ----
  // Cancellable bounded wait: await the real settle, but cap it at
  // SETTLE_HARD_BOUND_MS so a pathological platform failure cannot hang the
  // test forever. Unlike a bare `Promise.race`, the fallback timer is TRACKED in
  // `pendingWatchdogs` and CLEARED the instant the real settle wins — so no
  // timer survives the helper's resolution. If the bound wins instead, we mark
  // `cleanupComplete: false` (failing the assertions) rather than silently
  // calling cleanup done.
  const pendingWatchdogs = new Set<NodeJS.Timeout>();
  const boundedSettle = <T>(
    label: string,
    settle: Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false; reason: string }> =>
    new Promise((resolve) => {
      let done = false;
      const watchdog = setTimeout(() => {
        if (done) return;
        done = true;
        pendingWatchdogs.delete(watchdog);
        resolve({
          ok: false,
          reason: `${label} did not settle within ${SETTLE_HARD_BOUND_MS}ms`,
        });
      }, SETTLE_HARD_BOUND_MS);
      pendingWatchdogs.add(watchdog);
      settle.then(
        (value) => {
          if (done) return;
          done = true;
          clearTimeout(watchdog);
          pendingWatchdogs.delete(watchdog);
          resolve({ ok: true, value });
        },
        () => {
          if (done) return;
          done = true;
          clearTimeout(watchdog);
          pendingWatchdogs.delete(watchdog);
          resolve({ ok: false, reason: `${label} rejected before settling` });
        },
      );
    });

  const drainActiveProbes = async (): Promise<void> => {
    const inFlight = Array.from(activeProbes).map((h) => h.promise);
    if (inFlight.length === 0) return;
    await Promise.allSettled(inFlight);
    // All probe promises have settled; the AbortController entries were
    // removed via the `.finally` in the loop.
  };

  const finish = async (reason: string): Promise<void> => {
    if (settled) return;
    settled = true;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    // 1) Stop scheduling new probes (the loop sees `settled` on next tick).
    //    Cancel + settle any pending inter-probe delay so no delay timer leaks
    //    past resolution and the awaiting probeLoop unblocks immediately.
    cancelInterProbeDelays();
    // 2) Abort every in-flight probe.
    for (const h of activeProbes) h.controller.abort();
    // 3) Drain every probe (real await; no grace timer).
    await drainActiveProbes();
    // 4) Forcefully terminate the child if it's still alive.
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    // 5) Await the terminal settle signals (child `close`, stdout/stderr `end`)
    //    against the hard bound. `spawnError` is already set by the error
    //    handler when this path was triggered by a spawn failure.
    const spawnErr = spawnError;
    const [closeR, stdoutR, stderrR] = await Promise.all([
      boundedSettle("child close", childClosedResult),
      boundedSettle("stdout drain", stdoutDrained),
      boundedSettle("stderr drain", stderrDrained),
    ]);
    const closeOk = closeR.ok;
    const stdoutOk = stdoutR.ok;
    const stderrOk = stderrR.ok;
    const incompleteReasons: string[] = [];
    if (!closeR.ok) incompleteReasons.push(closeR.reason);
    if (!stdoutR.ok) incompleteReasons.push(stdoutR.reason);
    if (!stderrR.ok) incompleteReasons.push(stderrR.reason);
    const cleanupComplete = incompleteReasons.length === 0;
    const cleanupIncompleteReason = cleanupComplete ? undefined : incompleteReasons.join("; ");

    const closedResult = closeOk
      ? (closeR as { ok: true; value: { code: number | null; signal: NodeJS.Signals | null } })
          .value
      : { code: child.exitCode, signal: child.signalCode };
    if (spawnErr !== null) {
      const extra = `[spawn error] ${spawnErr.message}`;
      stderr = stderr ? `${stderr}\n${extra}`.slice(0, STDERR_LIMIT) : extra;
      if (stderr.length > STDERR_LIMIT) stderr = stderr.slice(0, STDERR_LIMIT);
    }

    const elapsed = Date.now() - startedAt;
    const diagnostics = [
      `port=${port} pid=${child.pid ?? "(none)"} durationMs=${elapsed}`,
      `reason=${reason}`,
      `ownsSelectedPort=${ownsPortObservedAt !== null} readyMarkerEmitted=${readyMarkerEmittedAt !== null}`,
      `cleanupComplete=${cleanupComplete}`,
      `closeObserved=${closeOk} stdoutSettled=${stdoutOk} stderrSettled=${stderrOk}`,
      `activeProbes=${activeProbes.size} pendingWatchdogs=${pendingWatchdogs.size} probeDelayWork=${pendingProbeDelays.size}`,
      `child.exitCode=${child.exitCode} child.signalCode=${child.signalCode}`,
      `spawnError=${spawnErr ? spawnErr.message : "(none)"}`,
      `probes=${JSON.stringify(probes)}`,
      `--- stdout ---\n${stdout || "(empty)"}`,
      `--- stderr ---\n${stderr || "(empty)"}`,
    ].join("\n");
    resolveOuter({
      exitCode: spawnErr !== null ? 127 : (closedResult.code ?? child.exitCode),
      signalCode: closedResult.signal ?? child.signalCode,
      becameServiceable,
      reason,
      diagnostics,
      childPid: child.pid,
      cleanupComplete,
      cleanupIncompleteReason,
      closeObserved: closeOk,
      stdoutSettled: stdoutOk,
      stderrSettled: stderrOk,
      activeProbesAtResolve: activeProbes.size,
      ownsSelectedPort: ownsPortObservedAt !== null,
      pendingWatchdogsAtResolve: pendingWatchdogs.size,
      probeDelayWorkAtResolve: pendingProbeDelays.size,
    });
  };

  child.once("error", (err) => {
    spawnError = err;
    void finish(`spawn error ${err.message}`);
  });

  child.once("exit", (code, signal) => {
    void finish(`child exit code=${code} signal=${signal}`);
  });

  timer = setTimeout(() => {
    void finish(`${timeoutMs}ms timeout`);
  }, timeoutMs);

  void probeLoop();

  return outer;
}

function assertNoSurvivingChild(label: string, outcome: Outcome): void {
  expect(
    outcome.cleanupComplete,
    `[${label}] cleanup must have fully settled; reason=${outcome.cleanupIncompleteReason}\n${outcome.diagnostics}`,
  ).toBe(true);
  expect(
    outcome.closeObserved,
    `[${label}] child must have emitted terminal close\n${outcome.diagnostics}`,
  ).toBe(true);
  expect(outcome.stdoutSettled, `[${label}] stdout must have drained\n${outcome.diagnostics}`).toBe(
    true,
  );
  expect(outcome.stderrSettled, `[${label}] stderr must have drained\n${outcome.diagnostics}`).toBe(
    true,
  );
  expect(
    outcome.activeProbesAtResolve,
    `[${label}] no in-flight probes must survive\n${outcome.diagnostics}`,
  ).toBe(0);
  expect(
    outcome.pendingWatchdogsAtResolve,
    `[${label}] no fallback watchdog timers may survive\n${outcome.diagnostics}`,
  ).toBe(0);
  expect(
    outcome.probeDelayWorkAtResolve,
    `[${label}] no inter-probe delay timers may survive\n${outcome.diagnostics}`,
  ).toBe(0);
  const pid = outcome.childPid;
  if (typeof pid === "number") {
    let err: NodeJS.ErrnoException | null = null;
    try {
      process.kill(pid, 0);
    } catch (e) {
      err = e as NodeJS.ErrnoException;
    }
    expect(
      err,
      `[${label}] process.kill(${pid}, 0) must throw (no surviving PID)\n${outcome.diagnostics}`,
    ).not.toBeNull();
    expect(
      err?.code,
      `[${label}] process.kill(${pid}, 0) must report ESRCH\n${outcome.diagnostics}`,
    ).toBe("ESRCH");
  }
}

describe.skipIf(!canRun)("standalone server config fail-fast (subprocess)", () => {
  it("exits non-zero and never binds when config is invalid (natural child exit)", async () => {
    const port = await reserveEphemeralPort();
    const env: Record<string, string | undefined> = { ...process.env };
    delete env.BACKEND_API_URL;
    delete env.PUBLIC_ORIGIN;
    env.NODE_ENV = "production";
    env.PUBLIC_ORIGIN = `http://127.0.0.1:${port}`;

    const outcome = await runServer({ env, port });

    expect(
      outcome.becameServiceable,
      `expected invalid-config server to never serve; reason=${outcome.reason}\n${outcome.diagnostics}`,
    ).toBe(false);
    expect(
      outcome.exitCode,
      `expected invalid-config server to exit non-zero; reason=${outcome.reason}\n${outcome.diagnostics}`,
    ).not.toBeNull();
    expect(
      outcome.exitCode,
      `expected invalid-config server to exit non-zero; reason=${outcome.reason}\n${outcome.diagnostics}`,
    ).not.toBe(0);
    assertNoSurvivingChild("invalid-config natural exit", outcome);
  }, 20_000);

  it("binds and becomes serviceable when config is valid (success path)", async () => {
    const port = await reserveEphemeralPort();
    const env: Record<string, string | undefined> = { ...process.env };
    env.NODE_ENV = "production";
    env.BACKEND_API_URL = "http://127.0.0.1:9";
    env.PUBLIC_ORIGIN = `http://127.0.0.1:${port}`;

    const outcome = await runServer({ env, port });

    expect(
      outcome.becameServiceable,
      `expected valid-config server to serve; reason=${outcome.reason}\n${outcome.diagnostics}`,
    ).toBe(true);
    expect(
      outcome.ownsSelectedPort,
      `expected the real standalone child to actually own the selected LISTEN socket (parent-observed /proc); reason=${outcome.reason}\n${outcome.diagnostics}`,
    ).toBe(true);
    assertNoSurvivingChild("success", outcome);
  }, 20_000);
});

describe.skipIf(!canRun)("subprocess helper lifecycle ownership", () => {
  // Controlled child fixture: starts an HTTP server that ACCEPTS but NEVER
  // responds to requests. The bind prints nothing to stdout, so the ready
  // marker never appears; probes connect, hang on the open request, and are
  // aborted by the helper. The HTTP server itself is held alive by an
  // interval until SIGKILL cleans up.
  function hangServerScript(port: number): string {
    return `
const http = require('node:http');
http.createServer(() => { /* accept; never respond */ })
    .listen(${port}, '127.0.0.1');
setInterval(() => {}, 60000);
`.trim();
  }

  // Controlled child fixture: emits assorted output — including near-miss
  // "Ready" tokens and a bare "✓ Ready" with no "in <N>ms" tail, written in
  // fragments and wrapped in ANSI framing — but does NOT emit the full
  // post-bind event and does NOT bind the port. A naive substring matcher would
  // be fooled; the buffered full-event regex must reject all of it.
  function readyLookalikeScript(): string {
    return `
process.stdout.write('Some app log: server is Ready to accept work soon\\n');
process.stdout.write('\\u001b[32m\\u2713 Ready\\u001b[39m');
process.stdout.write(' — but not really bound\\n');
process.stdout.write('Ready in a moment (no units)\\n');
setInterval(() => {}, 60000);
`.trim();
  }

  // Controlled child fixture for the direct-forgery adversary: emits the EXACT
  // `✓ Ready in 1ms` event — chunk-split across four writes and wrapped in real
  // ANSI SGR framing — so the buffered full-event regex genuinely matches, yet
  // NEVER binds the selected port. ESC (0x1b) and ✓ (0x2713) are built at
  // runtime via `String.fromCharCode` so no literal control byte lives in this
  // source file. Paired with an unrelated 200 responder owning the port, this is
  // the case where the marker + HTTP 200 + live child all hold but ownership
  // does not — only the parent-observed `/proc` check keeps it non-serviceable.
  function forgeExactMarkerScript(): string {
    return `
const ESC = String.fromCharCode(27);
const CHK = String.fromCharCode(0x2713);
const parts = [ESC + '[32m' + CHK, ' Rea', 'dy in ', '1ms' + ESC + '[39m' + '\\n'];
let i = 0;
(function w() { if (i < parts.length) { process.stdout.write(parts[i++]); setTimeout(w, 15); } })();
setInterval(() => {}, 60000);
`.trim();
  }

  // Controlled child fixture for the CACHED-OWNERSHIP takeover regression. It
  // deliberately reproduces the exact sequence a cached ownership check would be
  // fooled by:
  //   phase 1: THIS child binds the selected port and serves 200 (no marker),
  //            so early probes observe parent-/proc ownership of the child PID;
  //   handoff: it closes its own listener, then spawns a SEPARATE grandchild
  //            process (a different PID) that re-binds the SAME port and serves
  //            200; only once the grandchild confirms bound does the still-live
  //            child print the EXACT chunk-split ANSI `✓ Ready in 1ms` marker.
  // At readiness time all of marker + HTTP 200 + live child hold, and ownership
  // WAS observed earlier — but `/proc` now shows the LISTEN inode under the
  // grandchild PID, not the spawned child PID. A fresh per-probe ownership
  // recompute therefore returns false and the helper must stay non-serviceable.
  // The grandchild is fixture-internal plumbing: it exits on IPC `disconnect`
  // (fired when the helper SIGKILLs the child, closing the ipc pipe) and carries
  // a hard TTL backstop, so no listener and no `/proc` litter outlive the test.
  // The child↔grandchild IPC is NOT an ownership signal — nothing in the helper
  // consumes it; ownership is still proven solely from the parent via `/proc`.
  function bindThenReleaseTakeoverScript(port: number): string {
    const grandchild = `
const http = require('node:http');
const server = http.createServer((_req, res) => { res.writeHead(200); res.end('takeover-grandchild'); });
server.listen(${port}, '127.0.0.1', () => { if (typeof process.send === 'function') process.send('GC_BOUND'); });
process.on('disconnect', () => process.exit(0));
setTimeout(() => process.exit(0), 15000);
`.trim();
    return `
const http = require('node:http');
const { spawn } = require('node:child_process');
const server = http.createServer((_req, res) => { res.writeHead(200); res.end('phase1-child'); });
function printMarker() {
  const ESC = String.fromCharCode(27);
  const CHK = String.fromCharCode(0x2713);
  const parts = [ESC + '[32m' + CHK, ' Rea', 'dy in ', '1ms' + ESC + '[39m' + '\\n'];
  let i = 0;
  (function w() { if (i < parts.length) { process.stdout.write(parts[i++]); setTimeout(w, 15); } })();
}
function handoff() {
  server.close(() => {
    const gc = spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    gc.on('message', (m) => { if (m === 'GC_BOUND') printMarker(); });
  });
}
server.listen(${port}, '127.0.0.1', () => { setTimeout(handoff, 700); });
setInterval(() => {}, 60000);
`.trim();
  }

  it("rejects an unrelated 200 responder that takes the reserved port (adversarial bind-window takeover)", async () => {
    const port = await reserveEphemeralPort();
    const adversary = createServer((_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ADVERSARY");
    });
    await new Promise<void>((r) => adversary.listen(port, "127.0.0.1", () => r()));
    try {
      const outcome = await runServer({
        port,
        env: {
          ...process.env,
          NODE_ENV: "production",
          BACKEND_API_URL: "http://127.0.0.1:9",
          PUBLIC_ORIGIN: `http://127.0.0.1:${port}`,
        },
      });
      expect(
        outcome.becameServiceable,
        `adversarial 200 holder must not satisfy readiness; reason=${outcome.reason}\n${outcome.diagnostics}`,
      ).toBe(false);
      expect(
        outcome.exitCode,
        `child should have exited non-zero under EADDRINUSE; reason=${outcome.reason}\n${outcome.diagnostics}`,
      ).not.toBe(0);
      assertNoSurvivingChild("adversarial 200 holder", outcome);
    } finally {
      await new Promise<void>((r) => adversary.close(() => r()));
    }
  }, 20_000);

  it("rejects arbitrary child output that pretends to be the ready event", async () => {
    // Fixture: prints near-miss "Ready" tokens (including a bare "✓ Ready" with
    // no unit tail, in fragments, wrapped in ANSI) but does NOT bind the port.
    // A previously-broken `data`-chunk substring match could have been satisfied
    // by a child that merely printed the bytes; the buffered, full-event regex
    // (and the additional HTTP-200 + alive-child AND) ensures this stays
    // classified as not-serviceable.
    const port = await reserveEphemeralPort();
    const outcome = await runServer({
      port,
      env: { ...process.env },
      serverPath: SERVER,
      command: process.execPath,
      args: ["-e", readyLookalikeScript()],
      cwd: process.cwd(),
      timeoutMs: 2_000,
    });
    expect(
      outcome.becameServiceable,
      `marker alone (no bind, no 200) must not satisfy readiness; reason=${outcome.reason}\n${outcome.diagnostics}`,
    ).toBe(false);
    assertNoSurvivingChild("marker-only fixture", outcome);
  }, 20_000);

  it("rejects the bound-only fixture (owns-port + HTTP 200 + alive, no ready marker)", async () => {
    // Fixture: binds the port itself and serves 200 in response to `GET /`.
    // Because THIS spawned process genuinely holds the LISTEN socket, the
    // parent-observed `/proc` correlation DOES confirm ownership — so this proves
    // the ready marker is still enforced as an additional condition: it writes NO
    // `✓ Ready in …ms`, so `readyMarker=false` and readiness never holds despite
    // real ownership. The fixture runs forever until SIGKILL.
    const port = await reserveEphemeralPort();
    const script = `
const http = require('node:http');
http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('hi');
}).listen(${port}, '127.0.0.1');
setInterval(() => {}, 60000);
`.trim();
    const outcome = await runServer({
      port,
      env: { ...process.env },
      serverPath: SERVER,
      command: process.execPath,
      args: ["-e", script],
      cwd: process.cwd(),
      timeoutMs: 2_000,
    });
    expect(
      outcome.ownsSelectedPort,
      `bound-only child truly binds, so parent-observed /proc ownership must be TRUE; reason=${outcome.reason}\n${outcome.diagnostics}`,
    ).toBe(true);
    expect(
      outcome.becameServiceable,
      `bound-without-marker must not satisfy readiness; reason=${outcome.reason}\n${outcome.diagnostics}`,
    ).toBe(false);
    assertNoSurvivingChild("bound-only fixture", outcome);
  }, 20_000);

  it("rejects a child forging the exact chunk-split ANSI ready event while an unrelated 200 responder owns the port", async () => {
    // The decisive ownership case: an arbitrary child prints the EXACT
    // `✓ Ready in 1ms` event (chunk-split, ANSI-framed, so the full-event regex
    // genuinely matches) but never binds the selected port. An unrelated
    // responder owns the reserved port and answers `GET /` with 200. Marker,
    // HTTP 200, and a live child all hold — only the parent-observed `/proc`
    // ownership check is false (the child holds no LISTEN inode for the port),
    // and that alone keeps the helper non-serviceable. This is the gap a
    // stdout-only ownership signal could not close.
    const port = await reserveEphemeralPort();
    const responder = createServer((_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("UNRELATED-200");
    });
    await new Promise<void>((r) => responder.listen(port, "127.0.0.1", () => r()));
    try {
      const outcome = await runServer({
        port,
        env: { ...process.env },
        serverPath: SERVER,
        command: process.execPath,
        args: ["-e", forgeExactMarkerScript()],
        cwd: process.cwd(),
        timeoutMs: 2_000,
      });
      expect(
        outcome.ownsSelectedPort,
        `forged marker + unrelated 200 must NOT be observed as owning the port (child never bound it); reason=${outcome.reason}\n${outcome.diagnostics}`,
      ).toBe(false);
      expect(
        outcome.becameServiceable,
        `exact forged marker while another process owns the port must not satisfy readiness; reason=${outcome.reason}\n${outcome.diagnostics}`,
      ).toBe(false);
      assertNoSurvivingChild("forged-marker + unrelated 200", outcome);
    } finally {
      await new Promise<void>((r) => responder.close(() => r()));
    }
  }, 20_000);

  it("rejects readiness when ownership was observed earlier but the child released the port before the marker (cached-ownership takeover)", async () => {
    // Regression proving cached historical ownership cannot authorize a later
    // probe. The spawned child binds and serves 200 first (early probes observe
    // parent-/proc ownership of the child PID), then hands the SAME port to a
    // separate grandchild PID and only then prints the exact `✓ Ready in 1ms`
    // marker while staying alive. At the readiness decision, marker + HTTP 200 +
    // live child all hold and ownership WAS seen earlier — but a fresh per-probe
    // `/proc` recompute shows the child PID no longer holds the LISTEN inode, so
    // the helper must remain non-serviceable. A cached `ownsPort` would wrongly
    // pass here.
    const port = await reserveEphemeralPort();
    const outcome = await runServer({
      port,
      env: { ...process.env },
      serverPath: SERVER,
      command: process.execPath,
      args: ["-e", bindThenReleaseTakeoverScript(port)],
      cwd: process.cwd(),
      // Long enough to observe phase-1 ownership, the handoff, and the marker.
      timeoutMs: 3_000,
    });
    // The marker must actually have been emitted and an early ownership
    // observation must have occurred — otherwise the test would pass vacuously
    // without exercising the cached-ownership path.
    expect(
      outcome.diagnostics,
      `expected the exact ready marker to be emitted after handoff; reason=${outcome.reason}\n${outcome.diagnostics}`,
    ).toMatch(/readyMarkerEmitted=true/);
    expect(
      outcome.ownsSelectedPort,
      `expected an EARLY parent-/proc ownership observation (phase-1 child bind) for diagnostics; reason=${outcome.reason}\n${outcome.diagnostics}`,
    ).toBe(true);
    expect(
      outcome.becameServiceable,
      `cached ownership must not authorize readiness after the child released the port; reason=${outcome.reason}\n${outcome.diagnostics}`,
    ).toBe(false);
    assertNoSurvivingChild("cached-ownership takeover", outcome);
  }, 20_000);

  it("resolves on real OS spawn error (binary does not exist) without leaking", async () => {
    const port = await reserveEphemeralPort();
    const outcome = await runServer({
      port,
      env: { ...process.env },
      serverPath: SERVER,
      // Trigger Node's 'error' event via a path that cannot be execve'd; the
      // helper must surface ENOENT, complete cleanup, and leave nothing alive.
      command: "/this/binary/really/does/not/exist/anywhere/ever",
      args: [],
      cwd: process.cwd(),
      timeoutMs: 5_000,
    });
    expect(
      outcome.becameServiceable,
      `OS spawn error must not be confused with service; reason=${outcome.reason}\n${outcome.diagnostics}`,
    ).toBe(false);
    expect(
      outcome.diagnostics,
      `spawn ENOENT must surface in diagnostics; reason=${outcome.reason}\n${outcome.diagnostics}`,
    ).toMatch(/ENOENT/);
    assertNoSurvivingChild("OS spawn error", outcome);
  }, 20_000);

  it("times out readiness with an in-flight hanging probe (forced termination path)", async () => {
    // Fixture: starts a real HTTP server on the port that accepts but never
    // responds. The bind happens before the helper's first probe, so a probe
    // is IN-FLIGHT (hanging) when the READY_TIMEOUT_MS fires. finish() must
    // abort that hanging probe (no surviving probe), SIGKILL the child, await
    // the terminal close, and report full settlement.
    const port = await reserveEphemeralPort();
    const outcome = await runServer({
      port,
      env: { ...process.env },
      serverPath: SERVER,
      command: process.execPath,
      args: ["-e", hangServerScript(port)],
      cwd: process.cwd(),
      timeoutMs: 2_000,
    });
    expect(
      outcome.becameServiceable,
      `hanging probe must not satisfy readiness; reason=${outcome.reason}\n${outcome.diagnostics}`,
    ).toBe(false);
    expect(
      outcome.reason,
      `expected timeout-driven resolve; reason=${outcome.reason}\n${outcome.diagnostics}`,
    ).toMatch(/timeout/);
    expect(
      outcome.signalCode,
      `expected SIGKILL after timeout; reason=${outcome.reason}\n${outcome.diagnostics}`,
    ).toBe("SIGKILL");
    assertNoSurvivingChild("hanging probe timeout", outcome);
  }, 20_000);
});

// Visible skip markers so the suite never silently vanishes. One fires when the
// build artifact is missing; the other when the platform is not Linux (where
// dependency-free parent-observed socket ownership cannot be proven).
describe.skipIf(hasBuild)("standalone server config fail-fast (subprocess)", () => {
  it.skip("skipped: no .next/standalone/server.js — run `pnpm build` first", () => {});
});

describe.skipIf(IS_LINUX)("standalone server socket-ownership suite (subprocess)", () => {
  it.skip(`skipped: parent-observed /proc socket ownership is Linux-only (platform=${process.platform})`, () => {});
});
