// @vitest-environment jsdom
//
// P2.1 — EVERY WAY THE BASIS CLAIM CAN BE LOST, AND THE REASON EACH ONE REPORTS.
//
// Running without an immutable basis is a supported product state: the assistant is
// off by default and Optimize must work regardless. The defect was never the
// degradation, it was the SILENCE. Every exit on this path returned `null` without a
// word, and that is precisely what let the shipped build carry a completely unwired
// basis path through T08 and T10 with every isolated test green -- the screen never
// forwarded the semantic profile and the controller never had a store, and nothing
// anywhere said so.
//
// So these tests assert two things at once, and the second is the one that matters:
// the run still proceeds unclaimed, AND it says why. Each reason is forced at the
// layer that actually breaks -- a missing profile, an unavailable authority, implicit
// options, an unknown scenario identity, a throwing encoder, a refusing write, a
// refused bind -- through the real `useOptimizeRun`, not a re-implementation of it.

import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "fake-indexeddb/auto";

import type { InfoSemanticProfile } from "@/app/api/info/types";
import type { JobResponse } from "@/lib/bff/types";
import type { CanonicalScenarioDocument, PrepareOptimizeSubmissionResult } from "@/lib/scenario";
import { scenarioCommands } from "@/lib/store";
import { resetScenarioForTest } from "@/lib/store/test-authority";
import {
  createOptimizeObservability,
  OPTIMIZE_BASIS_DEGRADATIONS,
  type ObservedOptimizeEvent,
  type OptimizeBasisDegradation,
  type OptimizeBasisStore,
  type SessionTransactionStorage,
} from ".";
import { OPTIMIZE_SESSION_STORAGE_KEY } from "./session-transaction";
import { useOptimizeRun, type OptimizeRunSubmitInput } from "./use-optimize-run";

// The one seam a test cannot reach through the product: "the repository cannot tell us
// which scenario this is". Everything else below is forced through real inputs.
type IdentityOverride =
  | { scenarioId: string; documentRevision: number }
  | null
  /** The durable read REJECTS — what an unavailable IndexedDB actually does. */
  | "reject"
  | undefined;

const identityOverride: { value: IdentityOverride } = { value: undefined };

vi.mock("@/lib/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/store")>();
  return {
    ...actual,
    readAuthoritativeScenarioIdentity: async () => {
      if (identityOverride.value === undefined) return actual.readAuthoritativeScenarioIdentity();
      if (identityOverride.value === "reject") throw new Error("IndexedDB unavailable");
      return identityOverride.value;
    },
  };
});

const PROFILE: InfoSemanticProfile = {
  submission_contract_version: "optimize-yaml-v1",
  solver_semantic_version: "ortools/cp-sat@1",
  backend_capability_version: "nurse-scheduling-backend@1",
};

/** Deliberately distinctive so the redaction test can look for it by value. */
const SECRET_YAML =
  "workspaceVersion: 1\napiVersion: alpha\npeople:\n  items:\n    - id: SENSITIVE-NURSE-NAME\n";

const okPrep: PrepareOptimizeSubmissionResult = {
  ok: true,
  prep: { yaml: SECRET_YAML, peopleCount: 1, reverseMap: [], anonymized: false },
};

const originalFetch = globalThis.fetch;
let client: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client }, children);
}

const job: JobResponse = {
  id: "opt_basis_1",
  state: "queued",
  terminal: false,
  queue_position: 1,
  created_at: "2026-07-20T00:00:00+00:00",
  started_at: null,
  finished_at: null,
  expires_at: "2026-07-21T00:00:00+00:00",
  request: {
    input_name: "s.yaml",
    solver: "ortools/cp-sat",
    prettify: true,
    timeout_seconds: 300,
    purpose: "ordinary",
    basis: null,
  },
  result: null,
  error: null,
  controls: { cancellable: true, early_completion_available: false },
  links: {
    self: "/optimize/opt_basis_1",
    events: "/optimize/opt_basis_1/events",
    cancellation: "/optimize/opt_basis_1/cancel",
    early_completion: "/optimize/opt_basis_1/finish-now",
    schedule: null,
  },
};

function memStorage(): SessionTransactionStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  };
}

/** A store that records writes and can be made to fail either half on demand. */
function basisStore(
  over: { write?: () => Promise<void>; bind?: () => Promise<unknown> } = {},
): OptimizeBasisStore & { written: unknown[] } {
  const written: unknown[] = [];
  return {
    written,
    putOptimizeBasis: async (record) => {
      if (over.write) return over.write();
      written.push(record);
    },
    // COMMITS the verified row, exactly as the real adapter does inside its transaction.
    // Returning the verified row WITHOUT storing it would make the success control
    // vacuous: production could skip binding altogether and the written row would look
    // identical.
    bindOptimizeBasisJob: async (basisId, verify) => {
      if (over.bind) return (await over.bind()) as never;
      const index = written.findIndex((r) => (r as { basisId: string }).basisId === basisId);
      if (index === -1) return null;
      const bound = verify(written[index] as never);
      if (bound === null) return null;
      written[index] = bound;
      return bound;
    },
  };
}

function fullInput(over: Partial<OptimizeRunSubmitInput> = {}): OptimizeRunSubmitInput {
  return {
    document: {} as CanonicalScenarioDocument,
    anonymize: false,
    prettify: true,
    timeout: 300,
    semanticProfile: PROFILE,
    ...over,
  };
}

/** Submit once through the REAL controller and return the events it emitted. */
async function submitAndObserve(options: {
  input?: Partial<OptimizeRunSubmitInput>;
  store?: OptimizeBasisStore | null;
  max?: number;
  submissions?: number;
}) {
  const observability = createOptimizeObservability({ max: options.max });
  const deps = {
    prepare: () => okPrep,
    storage: memStorage(),
    observability,
    ...(options.store !== undefined ? { basisStore: options.store } : {}),
  };
  const { result } = renderHook(() => useOptimizeRun(deps), { wrapper });

  for (let i = 0; i < (options.submissions ?? 1); i += 1) {
    await act(async () => {
      await result.current.submit(fullInput(options.input));
    });
  }
  return { observability, events: observability.snapshot() };
}

const reasonsOf = (events: ObservedOptimizeEvent[]): OptimizeBasisDegradation[] =>
  events
    .map((e) => e.observation)
    .filter((o) => o.kind === "basis-degraded")
    .map((o) => (o as { reason: OptimizeBasisDegradation }).reason);

beforeEach(async () => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  identityOverride.value = undefined;
  await resetScenarioForTest();
  // A committed scenario, so the identity guard passes for every case except the one
  // that deliberately removes it.
  await scenarioCommands.mutate({
    staff: [{ id: "p1" }],
    shifts: [{ id: "day" }],
    rangeStart: "2026-07-01",
    rangeEnd: "2026-07-14",
  });
  globalThis.fetch = vi.fn(
    async () =>
      new Response(JSON.stringify(job), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  ) as typeof fetch;
});

afterEach(() => {
  cleanup();
  client.clear();
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  localStorage.removeItem(OPTIMIZE_SESSION_STORAGE_KEY);
});

describe("every basis degradation reports its own reason", () => {
  it("profile-unavailable when the backend advertised no semantic profile", async () => {
    const { events } = await submitAndObserve({
      input: { semanticProfile: null },
      store: basisStore(),
    });
    expect(reasonsOf(events)).toEqual(["profile-unavailable"]);
  });

  it("authority-unavailable when no durable basis authority could be acquired", async () => {
    const { events } = await submitAndObserve({ store: null });
    expect(reasonsOf(events)).toEqual(["authority-unavailable"]);
  });

  it("options-implicit when prettify or timeout was not explicit", async () => {
    // The backend binds its RESOLVED options, so a guessed default would fail
    // admission. Reported rather than silently dropped.
    const { events } = await submitAndObserve({
      input: { prettify: undefined },
      store: basisStore(),
    });
    expect(reasonsOf(events)).toEqual(["options-implicit"]);
  });

  it("scenario-identity-unavailable when the repository cannot name the scenario", async () => {
    identityOverride.value = null;
    const { events } = await submitAndObserve({ store: basisStore() });
    expect(reasonsOf(events)).toEqual(["scenario-identity-unavailable"]);
  });

  it("scenario-identity-unavailable when the durable identity read REJECTS", async () => {
    // THE ROUND-2 DEFECT. `readAuthoritativeScenarioIdentity` reaches Dexie-backed
    // repository authority and throws outright when IndexedDB is unavailable. It was
    // awaited outside every try boundary, so the rejection escaped the degradation
    // boundary completely: no reason emitted, no ordinary POST attempted, and the
    // submit latch left occupied.
    identityOverride.value = "reject";
    const observability = createOptimizeObservability();
    const { result } = renderHook(
      () =>
        useOptimizeRun({
          prepare: () => okPrep,
          storage: memStorage(),
          observability,
          basisStore: basisStore(),
        }),
      { wrapper },
    );

    let first: Awaited<ReturnType<typeof result.current.submit>> | null = null;
    await act(async () => {
      first = await result.current.submit(fullInput());
    });

    // It degrades, it does not enforce: the ordinary run is still accepted.
    expect(first).toMatchObject({ jobId: "opt_basis_1" });
    expect(reasonsOf(observability.snapshot())).toEqual(["scenario-identity-unavailable"]);

    // AND THE LATCH WAS RELEASED. A rejection that escaped `buildBasisForSubmission`
    // left `submitAttemptRef` set, so the next submit came back
    // `blocked-before-post / submission-in-progress` forever. A second submit proves
    // there is no poison.
    let second: Awaited<ReturnType<typeof result.current.submit>> | null = null;
    await act(async () => {
      second = await result.current.submit(fullInput());
    });
    // The precise claim: not "the second submit succeeds" -- a run is live now, so the
    // session-record guard may legitimately block it -- but that it is never blocked by
    // the LATCH. `submission-in-progress` is the only reason that latch produces.
    expect((second as { reason?: string } | null)?.reason).not.toBe("submission-in-progress");
  });

  it("basis-build-failed when the encoder throws (an insecure origin has no Web Crypto)", async () => {
    vi.spyOn(globalThis.crypto.subtle, "digest").mockRejectedValue(new Error("no subtle crypto"));
    const { events } = await submitAndObserve({ store: basisStore() });
    expect(reasonsOf(events)).toEqual(["basis-build-failed"]);
  });

  it("basis-write-failed when the durable pre-POST write refuses", async () => {
    // DISTINCT from build-failed on purpose. One try around both would make "Web
    // Crypto is missing" and "IndexedDB refused the write" indistinguishable, and they
    // are the two most different causes on this path.
    const store = basisStore({
      write: () => Promise.reject(new Error("QuotaExceededError")),
    });
    const { events } = await submitAndObserve({ store });
    expect(reasonsOf(events)).toEqual(["basis-write-failed"]);
  });

  it("basis-bind-failed when the bind THROWS, not merely refuses", async () => {
    const store = basisStore({ bind: () => Promise.reject(new Error("bind exploded")) });
    const { events } = await submitAndObserve({ store });
    expect(events.map((e) => e.observation)).toEqual([
      { kind: "basis-degraded", jobId: "opt_basis_1", reason: "basis-bind-failed" },
    ]);
    // The exception text never reaches the surface.
    expect(JSON.stringify(events)).not.toContain("bind exploded");
  });

  it("basis-bind-failed when the accepted job's echoed identity is refused", async () => {
    // A REFUSAL IS NOT A THROW: `bindOptimizeBasisJob` resolves null when the echoed
    // identity disagrees. That is the likelier failure and was just as silent.
    const store = basisStore({ bind: () => Promise.resolve(null) });
    const { events } = await submitAndObserve({ store });
    expect(reasonsOf(events)).toEqual(["basis-bind-failed"]);
  });

  it("reports the accepted job id ONLY for the one reason raised after the POST", async () => {
    const bind = await submitAndObserve({
      store: basisStore({ bind: () => Promise.resolve(null) }),
    });
    const bindEvent = bind.events.find((e) => e.observation.kind === "basis-degraded");
    expect(bindEvent?.observation).toMatchObject({
      reason: "basis-bind-failed",
      jobId: "opt_basis_1",
    });

    // Every other reason is raised BEFORE the job exists, so inventing an id would be
    // a lie about which run it refers to.
    const pre = await submitAndObserve({ input: { semanticProfile: null }, store: basisStore() });
    expect(pre.events[0]?.observation).toMatchObject({
      reason: "profile-unavailable",
      jobId: null,
    });
  });

  it("covers the whole taxonomy — no reason is unreachable or untested", () => {
    // Guards against a code being added to the union and never exercised.
    const tested: OptimizeBasisDegradation[] = [
      "profile-unavailable",
      "authority-unavailable",
      "options-implicit",
      "scenario-identity-unavailable",
      "basis-build-failed",
      "basis-write-failed",
      "basis-bind-failed",
    ];
    expect([...tested].sort()).toEqual([...OPTIMIZE_BASIS_DEGRADATIONS].sort());
  });
});

describe("the degradation is reported, never enforced", () => {
  it("emits NOTHING when the basis is claimed — absence is the success signal", async () => {
    const store = basisStore();
    // The backend must ECHO the claim for the bind to succeed. `bindAcceptedJob` binds
    // only on an exactly matching `basis_id` + `input_sha256`, so a fixture that
    // returned `basis: null` would correctly produce `basis-bind-failed` and this
    // control would be testing the wrong thing.
    // A COMPLETE `JobBasis`. A partial echo is not a weaker fixture, it is an invalid
    // JobResponse: the strict parser rejects the whole body, the submission fails before
    // any bind, and an "emitted nothing" assertion then passes for entirely the wrong
    // reason. That is the vacuity this control exists to avoid.
    globalThis.fetch = vi.fn(async () => {
      const w = store.written[0] as
        | {
            basisId: string;
            submissionDigest: string;
            parentBasisId: string | null;
            transformDigest: string | null;
            basis: {
              submissionContractVersion: string;
              workspaceSchemaVersion: string;
              serializerVersion: string;
              anonymizationMode: string;
              solverSemanticVersion: string;
              backendCapabilityVersion: string;
              normalizedOptions: { solver: string; prettify: boolean; timeoutSeconds: number };
            };
          }
        | undefined;
      const echoed =
        w === undefined
          ? null
          : {
              basis_id: w.basisId,
              schema_version: 2,
              submission_contract_version: w.basis.submissionContractVersion,
              workspace_schema_version: w.basis.workspaceSchemaVersion,
              serializer_version: w.basis.serializerVersion,
              anonymization_mode: w.basis.anonymizationMode,
              input_sha256: w.submissionDigest,
              normalized_options: {
                solver: w.basis.normalizedOptions.solver,
                prettify: w.basis.normalizedOptions.prettify,
                timeout_seconds: w.basis.normalizedOptions.timeoutSeconds,
              },
              solver_semantic_version: w.basis.solverSemanticVersion,
              backend_capability_version: w.basis.backendCapabilityVersion,
              parent_basis_id: w.parentBasisId,
              transform_digest: w.transformDigest,
            };
      return new Response(JSON.stringify({ ...job, request: { ...job.request, basis: echoed } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const { events } = await submitAndObserve({ store });

    expect(reasonsOf(events)).toEqual([]);
    // NON-VACUITY, and this is the assertion that makes the control mean something.
    // Asserting the row's `jobId` is still null would pass even if production skipped
    // binding entirely -- the row would be written either way. The fake now COMMITS the
    // verified row like the real adapter, so the stored id is proof the bind actually
    // ran and verified.
    expect(store.written).toHaveLength(1);
    expect((store.written[0] as { jobId: string | null }).jobId).toBe("opt_basis_1");
  });

  it("still accepts the job when the claim was lost", async () => {
    // The product contract the review asked to preserve: an ordinary run proceeds.
    const observability = createOptimizeObservability();
    const { result } = renderHook(
      () =>
        useOptimizeRun({
          prepare: () => okPrep,
          storage: memStorage(),
          observability,
          basisStore: null,
        }),
      { wrapper },
    );

    let outcome: Awaited<ReturnType<typeof result.current.submit>> | null = null;
    await act(async () => {
      outcome = await result.current.submit(fullInput());
    });

    expect(outcome).toMatchObject({ jobId: "opt_basis_1" });
    expect(reasonsOf(observability.snapshot())).toEqual(["authority-unavailable"]);
  });

  it("cannot fail a run through a throwing sink", async () => {
    const observability = createOptimizeObservability({
      sink: () => {
        throw new Error("sink exploded");
      },
    });
    const { result } = renderHook(
      () =>
        useOptimizeRun({
          prepare: () => okPrep,
          storage: memStorage(),
          observability,
          basisStore: null,
        }),
      { wrapper },
    );

    let outcome: Awaited<ReturnType<typeof result.current.submit>> | null = null;
    await act(async () => {
      outcome = await result.current.submit(fullInput());
    });
    expect(outcome).toMatchObject({ jobId: "opt_basis_1" });
  });
});

describe("the surface stays bounded and carries nothing sensitive", () => {
  it("evicts oldest-first at the configured budget", async () => {
    const { events } = await submitAndObserve({
      input: { semanticProfile: null },
      store: basisStore(),
      max: 3,
      submissions: 6,
    });
    // Six degradations, a budget of three: a noisy run cannot grow memory.
    expect(events).toHaveLength(3);
    expect(reasonsOf(events)).toEqual([
      "profile-unavailable",
      "profile-unavailable",
      "profile-unavailable",
    ]);
  });

  it("carries the reason code and a job id, and nothing else", async () => {
    const store = basisStore({ write: () => Promise.reject(new Error("QuotaExceededError")) });
    const { events } = await submitAndObserve({
      input: { semanticProfile: PROFILE },
      store,
    });

    const [event] = events;
    expect(event).toBeDefined();
    // The EXACT shape: three keys, no more. A future field cannot be added without
    // this failing and someone deciding whether it is safe to emit.
    expect(Object.keys(event!.observation).sort()).toEqual(["jobId", "kind", "reason"]);

    const serialized = JSON.stringify(events);
    // Nothing from the submission, the scenario, or the exception may appear.
    expect(serialized).not.toContain("SENSITIVE-NURSE-NAME");
    expect(serialized).not.toContain("workspaceVersion");
    expect(serialized).not.toContain("QuotaExceededError");
    expect(serialized).not.toContain("ortools/cp-sat@1");
    // Sensitivity: the check can actually see a planted value.
    expect(SECRET_YAML).toContain("SENSITIVE-NURSE-NAME");
  });

  it("pins the first-broken ORDER, not just each reason in isolation", async () => {
    // Each reason above is forced alone, so a guard-reordering mutation would leave the
    // whole suite green. This drives TWO faults at once and demands the earlier layer
    // win, walking the declared precedence one link at a time:
    // profile → authority → options → identity → build → write → bind.
    const cases: {
      label: string;
      expected: OptimizeBasisDegradation;
      run: () => Promise<ObservedOptimizeEvent[]>;
    }[] = [
      {
        label: "profile before authority",
        expected: "profile-unavailable",
        run: async () =>
          (await submitAndObserve({ input: { semanticProfile: null }, store: null })).events,
      },
      {
        label: "authority before options",
        expected: "authority-unavailable",
        run: async () =>
          (await submitAndObserve({ input: { prettify: undefined }, store: null })).events,
      },
      {
        label: "options before identity",
        expected: "options-implicit",
        run: async () => {
          identityOverride.value = "reject";
          return (await submitAndObserve({ input: { prettify: undefined }, store: basisStore() }))
            .events;
        },
      },
      {
        label: "identity before build",
        expected: "scenario-identity-unavailable",
        run: async () => {
          identityOverride.value = "reject";
          vi.spyOn(globalThis.crypto.subtle, "digest").mockRejectedValue(new Error("no crypto"));
          return (await submitAndObserve({ store: basisStore() })).events;
        },
      },
      {
        label: "build before write",
        expected: "basis-build-failed",
        run: async () => {
          vi.spyOn(globalThis.crypto.subtle, "digest").mockRejectedValue(new Error("no crypto"));
          return (
            await submitAndObserve({
              store: basisStore({ write: () => Promise.reject(new Error("nope")) }),
            })
          ).events;
        },
      },
      {
        label: "write before bind",
        expected: "basis-write-failed",
        run: async () =>
          (
            await submitAndObserve({
              store: basisStore({
                write: () => Promise.reject(new Error("nope")),
                bind: () => Promise.reject(new Error("also nope")),
              }),
            })
          ).events,
      },
    ];

    for (const { label, expected, run } of cases) {
      identityOverride.value = undefined;
      vi.restoreAllMocks();
      const events = await run();
      expect(reasonsOf(events), label).toEqual([expected]);
    }
  });

  it("has finite cardinality — every reason comes from the closed taxonomy", async () => {
    const { events } = await submitAndObserve({
      input: { semanticProfile: null },
      store: basisStore(),
      submissions: 3,
    });
    for (const reason of reasonsOf(events)) {
      expect(OPTIMIZE_BASIS_DEGRADATIONS).toContain(reason);
    }
  });
});
