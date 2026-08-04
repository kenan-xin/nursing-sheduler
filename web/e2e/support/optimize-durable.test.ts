import { describe, expect, it, vi } from "vitest";
import {
  ABORT_BOUNDS,
  ABORT_TEST_TIMEOUT,
  CLEANUP_BOUNDS,
  cleanupKnownJob,
  cleanupKnownJobs,
  CURSOR_VERSION,
  decodePublicCursor,
  finishSubmitObservation,
  isOptimizeSubmitRequest,
  judgeReplayEvidence,
  observeOptimizeSubmit,
  PRODUCT_SOLVE_LIMIT,
  REPLAY_TEST_TIMEOUT,
  runObservedSubmitAction,
  TINY_BOUNDS,
  TINY_TEST_TIMEOUT,
  type CleanupHttp,
  type ReplayEvidence,
  type SubmitEvents,
  type SubmitRequest,
  type SubmitResponse,
  type SubmitSource,
} from "./optimize-durable";

class Source implements SubmitSource {
  private handlers: { [K in keyof SubmitEvents]: Set<(value: SubmitEvents[K]) => void> } = {
    request: new Set(),
    requestfailed: new Set(),
    response: new Set(),
  };

  on<K extends keyof SubmitEvents>(event: K, handler: (value: SubmitEvents[K]) => void): void {
    this.handlers[event].add(handler);
  }

  off<K extends keyof SubmitEvents>(event: K, handler: (value: SubmitEvents[K]) => void): void {
    this.handlers[event].delete(handler);
  }

  emit<K extends keyof SubmitEvents>(event: K, value: SubmitEvents[K]): void {
    for (const handler of this.handlers[event]) handler(value);
  }
}

function request(url = "http://localhost:51236/api/optimize"): SubmitRequest {
  return { method: () => "POST", url: () => url };
}

function response(
  req: SubmitRequest,
  status: number,
  body: () => Promise<unknown>,
): SubmitResponse {
  return { request: () => req, status: () => status, json: body };
}

async function finish(source: Source, setup: (source: Source) => void) {
  const observer = observeOptimizeSubmit(source);
  setup(source);
  return finishSubmitObservation(observer, async () => undefined);
}

describe("page-fenced submit observer", () => {
  it("matches only the exact POST /api/optimize request", () => {
    expect(isOptimizeSubmitRequest(request())).toBe(true);
    expect(isOptimizeSubmitRequest(request("/api/optimize?retry=1"))).toBe(false);
    expect(isOptimizeSubmitRequest({ method: () => "GET", url: () => "/api/optimize" })).toBe(
      false,
    );
    expect(isOptimizeSubmitRequest(request("/api/optimize/job"))).toBe(false);
  });

  it("records one accepted 202 id after the page-close fence", async () => {
    const req = request();
    const result = await finish(new Source(), (source) => {
      source.emit("request", req);
      source.emit(
        "response",
        response(req, 202, async () => ({ id: "job-1" })),
      );
    });
    expect(result).toEqual({
      matchingRequests: 1,
      acceptedSlots: [{ kind: "id", jobId: "job-1" }],
      knownIds: ["job-1"],
      failures: [],
      lostAuthority: false,
    });
  });

  it("keeps a non-202 matching response in the exactly-one request verdict", async () => {
    const req = request();
    const result = await finish(new Source(), (source) => {
      source.emit("request", req);
      source.emit(
        "response",
        response(req, 409, async () => ({ detail: "busy" })),
      );
    });
    expect(result.matchingRequests).toBe(1);
    expect(result.acceptedSlots).toEqual([]);
    expect(result.failures).toContain("expected exactly one accepted 202, observed 0");
    expect(result.lostAuthority).toBe(false);
  });

  it("registers an accepted id before propagating a click-first failure", async () => {
    const source = new Source();
    const observer = observeOptimizeSubmit(source);
    const req = request();
    const primary = new Error("click failed");
    source.emit("request", req);

    await expect(
      runObservedSubmitAction(
        observer,
        async () => {
          throw primary;
        },
        async () => {
          source.emit(
            "response",
            response(req, 202, async () => ({ id: "job-click" })),
          );
        },
      ),
    ).rejects.toBe(primary);
    expect(observer.result()?.knownIds).toEqual(["job-click"]);
  });

  it("registers an accepted id before propagating a response-first failure", async () => {
    const source = new Source();
    const observer = observeOptimizeSubmit(source);
    const req = request();
    const primary = new Error("action failed after response");
    await expect(
      runObservedSubmitAction(
        observer,
        async () => {
          source.emit("request", req);
          source.emit(
            "response",
            response(req, 202, async () => ({ id: "job-response" })),
          );
          throw primary;
        },
        async () => undefined,
      ),
    ).rejects.toBe(primary);
    expect(observer.result()?.knownIds).toEqual(["job-response"]);
  });

  it.each([
    ["missing", async () => ({})],
    ["empty", async () => ({ id: "" })],
    ["unreadable", async () => Promise.reject(new Error("body unreadable"))],
  ])("treats a %s accepted body as lost authority", async (_label, body) => {
    const req = request();
    const result = await finish(new Source(), (source) => {
      source.emit("request", req);
      source.emit("response", response(req, 202, body));
    });
    expect(result.lostAuthority).toBe(true);
    expect(result.failures).not.toEqual([]);
  });

  it("treats an accepted body still unresolved at settlement as lost authority", async () => {
    const source = new Source();
    let clock = 0;
    const observer = observeOptimizeSubmit(source, {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    const req = request();
    source.emit("request", req);
    source.emit(
      "response",
      response(req, 202, () => new Promise<unknown>(() => undefined)),
    );
    const result = await observer.settleAfterPageClose(2);
    expect(result.acceptedSlots).toEqual([{ kind: "unresolved" }]);
    expect(result.lostAuthority).toBe(true);
  });

  it("persists a failed page-close fence in the observer result", async () => {
    const source = new Source();
    const observer = observeOptimizeSubmit(source);
    const result = await finishSubmitObservation(observer, async () => {
      throw new Error("close rejected");
    });
    expect(result.lostAuthority).toBe(true);
    expect(observer.result()?.failures[0]).toContain("page-close fence failed: close rejected");
  });

  it("captures a duplicate that begins immediately before page close", async () => {
    const source = new Source();
    const observer = observeOptimizeSubmit(source);
    const first = request();
    source.emit("request", first);
    source.emit(
      "response",
      response(first, 202, async () => ({ id: "job-1" })),
    );
    const result = await finishSubmitObservation(observer, async () => {
      const duplicate = request();
      source.emit("request", duplicate);
      source.emit(
        "response",
        response(duplicate, 202, async () => ({ id: "job-2" })),
      );
    });
    expect(result.matchingRequests).toBe(2);
    expect(result.knownIds).toEqual(["job-1", "job-2"]);
    expect(result.failures).toContain("expected exactly one matching submit request, observed 2");
    expect(result.lostAuthority).toBe(false);
  });

  it("keeps duplicate slot cardinality red while deduplicating the physical id", async () => {
    const source = new Source();
    const observer = observeOptimizeSubmit(source);
    for (let index = 0; index < 2; index += 1) {
      const req = request();
      source.emit("request", req);
      source.emit(
        "response",
        response(req, 202, async () => ({ id: "same-job" })),
      );
    }
    const result = await finishSubmitObservation(observer, async () => undefined);
    expect(result.acceptedSlots).toHaveLength(2);
    expect(result.knownIds).toEqual(["same-job"]);
    expect(result.failures).toContain("expected exactly one accepted 202, observed 2");
  });

  it("treats a matching request still in flight at the fence as lost authority", async () => {
    const req = request();
    const result = await finish(new Source(), (source) => source.emit("request", req));
    expect(result.lostAuthority).toBe(true);
    expect(result.failures.join(" | ")).toContain("remained unresolved");
  });

  it("routes more than two matching requests to lost-authority containment", async () => {
    const source = new Source();
    const observer = observeOptimizeSubmit(source);
    for (let index = 0; index < 3; index += 1) {
      const req = request();
      source.emit("request", req);
      source.emit(
        "response",
        response(req, 202, async () => ({ id: `job-${index}` })),
      );
    }
    expect((await finishSubmitObservation(observer, async () => undefined)).lostAuthority).toBe(
      true,
    );
  });
});

function terminalBody(terminal: boolean): string {
  return JSON.stringify({ state: terminal ? "cancelled" : "cancelling", terminal });
}

function scriptedHttp(options: {
  post?: () => Promise<{ status: number; body: string }>;
  get: (url: string) => Promise<{ status: number; body: string }>;
  delete?: () => Promise<{ status: number; body: string }>;
  calls: string[];
}): CleanupHttp {
  let clock = 0;
  return {
    post: async (url) => {
      options.calls.push(`POST ${url}`);
      return options.post?.() ?? { status: 202, body: "" };
    },
    get: async (url) => {
      options.calls.push(`GET ${url}`);
      return options.get(url);
    },
    delete: async (url) => {
      options.calls.push(`DELETE ${url}`);
      return options.delete?.() ?? { status: 204, body: "" };
    },
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  };
}

describe("known-id cleanup", () => {
  it("executes cancel, terminal proof, safe delete and exact final GET 404", async () => {
    const calls: string[] = [];
    let statusReads = 0;
    const outcome = await cleanupKnownJob(
      "job-1",
      scriptedHttp({
        calls,
        get: async () => {
          statusReads += 1;
          return statusReads === 1
            ? { status: 200, body: terminalBody(false) }
            : statusReads === 2
              ? { status: 200, body: terminalBody(true) }
              : { status: 404, body: "" };
        },
      }),
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.removedIds).toEqual(["job-1"]);
    expect(calls).toEqual([
      "POST /api/optimize/job-1/cancel",
      "GET /api/optimize/job-1",
      "GET /api/optimize/job-1",
      "DELETE /api/optimize/job-1",
      "GET /api/optimize/job-1",
    ]);
    expect(outcome.steps.at(-1)).toBe("cleanup success job-1: final GET 404");
  });

  it("attempts final GET after cancel transport failure and never performs unsafe DELETE", async () => {
    const calls: string[] = [];
    const outcome = await cleanupKnownJob(
      "job-1",
      scriptedHttp({
        calls,
        post: async () => Promise.reject(new Error("socket closed")),
        get: async () => ({ status: 404, body: "" }),
      }),
    );
    expect(outcome.ok).toBe(false);
    expect(calls).toEqual(["POST /api/optimize/job-1/cancel", "GET /api/optimize/job-1"]);
    expect(calls.some((call) => call.startsWith("DELETE"))).toBe(false);
  });

  it("attempts final GET after malformed status and never deletes without terminal proof", async () => {
    const calls: string[] = [];
    let reads = 0;
    const outcome = await cleanupKnownJob(
      "job-1",
      scriptedHttp({
        calls,
        get: async () => {
          reads += 1;
          return reads === 1 ? { status: 200, body: "not-json" } : { status: 404, body: "" };
        },
      }),
    );
    expect(outcome.ok).toBe(false);
    expect(calls.at(-1)).toBe("GET /api/optimize/job-1");
    expect(calls.some((call) => call.startsWith("DELETE"))).toBe(false);
  });

  it("requires exact final GET 404", async () => {
    const calls: string[] = [];
    let reads = 0;
    const outcome = await cleanupKnownJob(
      "job-1",
      scriptedHttp({
        calls,
        get: async () => {
          reads += 1;
          return reads === 1
            ? { status: 200, body: terminalBody(true) }
            : { status: 200, body: terminalBody(true) };
        },
      }),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.failures).toContain("final GET returned 200; expected exact 404");
    expect(outcome.removedIds).toEqual([]);
  });

  it("cleans two distinct ids concurrently and settles both branches", async () => {
    let active = 0;
    let maxActive = 0;
    const finalReads = new Map<string, number>();
    const http: CleanupHttp = {
      post: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        active -= 1;
        return { status: 202, body: "" };
      },
      get: async (url) => {
        const reads = (finalReads.get(url) ?? 0) + 1;
        finalReads.set(url, reads);
        return reads === 1 ? { status: 200, body: terminalBody(true) } : { status: 404, body: "" };
      },
      delete: async () => ({ status: 204, body: "" }),
      sleep: async () => undefined,
      now: () => 0,
    };
    const outcome = await cleanupKnownJobs(["job-1", "job-2"], http);
    expect(outcome.ok).toBe(true);
    expect(maxActive).toBe(2);
    expect(outcome.removedIds.sort()).toEqual(["job-1", "job-2"]);
  });

  it("rejects more than two normal-cleanup ids without starting a branch", async () => {
    const post = vi.fn();
    const outcome = await cleanupKnownJobs(["a", "b", "c"], {
      post,
      get: vi.fn(),
      delete: vi.fn(),
      sleep: vi.fn(),
      now: () => 0,
    });
    expect(outcome.ok).toBe(false);
    expect(post).not.toHaveBeenCalled();
  });

  it("pins the executable 5/65/3 cleanup composition and final reservation", () => {
    expect(CLEANUP_BOUNDS.closeAndSettle).toBe(5_000);
    expect(CLEANUP_BOUNDS.lifecycle).toBe(65_000);
    expect(CLEANUP_BOUNDS.report).toBe(3_000);
    expect(
      CLEANUP_BOUNDS.closeAndSettle +
        Math.max(CLEANUP_BOUNDS.lifecycle, CLEANUP_BOUNDS.lifecycle) +
        CLEANUP_BOUNDS.report,
    ).toBe(73_000);
    expect(73_000).toBeLessThan(CLEANUP_BOUNDS.hook);
    expect(
      CLEANUP_BOUNDS.cancel +
        CLEANUP_BOUNDS.terminal +
        CLEANUP_BOUNDS.delete +
        CLEANUP_BOUNDS.transitionReserve,
    ).toBe(CLEANUP_BOUNDS.lifecycle - CLEANUP_BOUNDS.finalGet);
    expect(CLEANUP_BOUNDS.finalGet).toBe(8_000);
  });
});

function segment(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function cursor(jobId: string, nativeId: string): string {
  return `${CURSOR_VERSION}.${segment(jobId)}.${segment(nativeId)}`;
}

const JOB = "job accepted";
const FOREIGN = "job foreign";
const BEFORE = cursor(JOB, "100-0");
const AFTER_1 = cursor(JOB, "101-0");
const AFTER_2 = cursor(JOB, "102-0");
const ORIGIN = "http://localhost:51236";
const PATH = `/api/optimize/${encodeURIComponent(JOB)}/events`;

function evidence(overrides: Partial<ReplayEvidence> = {}): ReplayEvidence {
  const first = { url: `${ORIGIN}${PATH}`, lastEventId: BEFORE };
  return {
    acceptedJobId: JOB,
    expectedOrigin: ORIGIN,
    cursorBefore: BEFORE,
    preReloadIds: [BEFORE],
    preReloadRequests: [{ url: `${ORIGIN}${PATH}`, lastEventId: null }],
    firstResumedRequest: first,
    postReloadRequests: [first],
    replayIds: [AFTER_1, AFTER_2],
    cursorAfter: AFTER_2,
    ...overrides,
  };
}

describe("compact replay and every-request authority judge", () => {
  it("accepts a valid multi-frame replay", () => {
    expect(judgeReplayEvidence(evidence())).toEqual({ ok: true, failures: [] });
  });

  it.each([
    ["stale", evidence({ replayIds: [BEFORE], cursorAfter: BEFORE })],
    ["duplicate", evidence({ replayIds: [AFTER_1, AFTER_1], cursorAfter: AFTER_1 })],
    ["missing", evidence({ replayIds: [], cursorAfter: null })],
    ["malformed", evidence({ replayIds: ["garbage"], cursorAfter: "garbage" })],
    [
      "foreign-only",
      evidence({
        replayIds: [cursor(FOREIGN, "101-0")],
        cursorAfter: cursor(FOREIGN, "101-0"),
      }),
    ],
    [
      "mixed-foreign",
      evidence({
        replayIds: [AFTER_1, cursor(FOREIGN, "102-0")],
        cursorAfter: AFTER_1,
      }),
    ],
  ])("rejects %s replay evidence", (_label, input) => {
    expect(judgeReplayEvidence(input).ok).toBe(false);
  });

  it.each([
    ["foreign origin", `${ORIGIN.replace("localhost", "127.0.0.1")}${PATH}`],
    ["wrong path", `${ORIGIN}/api/optimize/wrong/events`],
    ["query", `${ORIGIN}${PATH}?cursor=1`],
    ["fragment", `${ORIGIN}${PATH}#tail`],
  ])("rejects a %s in every pre/post effective request", (_label, url) => {
    const bad = { url, lastEventId: BEFORE };
    const judged = judgeReplayEvidence(
      evidence({ preReloadRequests: [bad], firstResumedRequest: bad, postReloadRequests: [bad] }),
    );
    expect(judged.ok).toBe(false);
  });

  it("requires the paired first resumed request to be post-reload index zero", () => {
    const first = { url: `${ORIGIN}${PATH}`, lastEventId: BEFORE };
    const different = { url: `${ORIGIN}${PATH}`, lastEventId: null };
    expect(
      judgeReplayEvidence(
        evidence({ firstResumedRequest: first, postReloadRequests: [different, first] }),
      ).failures,
    ).toContain("first resumed request was not the same-index first post-reload request");
  });

  it("decodes the minimal canonical public cursor and rejects an alias", () => {
    expect(decodePublicCursor(BEFORE)).toEqual({ jobId: JOB, nativeEventId: "100-0" });
    expect(decodePublicCursor(`${CURSOR_VERSION}.MR.${segment("100-0")}`)).toBeNull();
  });
});

describe("simple assembled lane caps", () => {
  it("pins the four outcome caps without reconstructing helper arithmetic", () => {
    expect(TINY_TEST_TIMEOUT).toBe(240_000);
    expect(REPLAY_TEST_TIMEOUT).toBe(240_000);
    expect(ABORT_TEST_TIMEOUT).toBe(180_000);
    expect(CLEANUP_BOUNDS.hook).toBe(75_000);
    expect(TINY_BOUNDS.completionPoll).toBe(90_000);
    expect(ABORT_BOUNDS.abortUrlSettle).toBe(30_000);
    expect(TINY_TEST_TIMEOUT).toBeLessThan(PRODUCT_SOLVE_LIMIT);
    expect(REPLAY_TEST_TIMEOUT).toBeLessThan(PRODUCT_SOLVE_LIMIT);
    expect(ABORT_TEST_TIMEOUT).toBeLessThan(PRODUCT_SOLVE_LIMIT);
  });
});
