import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AI_AGENT_ID, AI_RUNTIME_INSTANCE_HEADER, COPILOT_RUNTIME_URL } from "@/lib/ai/protocol";
import {
  isConfirmedStop,
  primeRuntimeInstanceId,
  peekRuntimeInstanceId,
  readActiveRunHandle,
  requestRuntimeStop,
  resetRuntimeInstanceForTest,
  setActiveRunHandle,
} from "./runtime-stop";
import { SENTINEL_KEY } from "./test-support";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  resetRuntimeInstanceForTest();
  setActiveRunHandle(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the stop route call", () => {
  it("addresses this thread's run on the multi-route runtime", async () => {
    const fetchImpl = vi.fn(async () => json({ stopped: true }));

    await requestRuntimeStop({
      threadId: "thread with spaces/and-slashes",
      runtimeInstanceId: "instance-1",
      fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
    });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      `${COPILOT_RUNTIME_URL}/agent/${AI_AGENT_ID}/stop/${encodeURIComponent("thread with spaces/and-slashes")}`,
    );
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)[AI_RUNTIME_INSTANCE_HEADER]).toBe("instance-1");
  });

  it("never sends the credential -- the stop route is keyless by design", async () => {
    const fetchImpl = vi.fn(async () => json({ stopped: true }));

    await requestRuntimeStop({
      threadId: "thread-1",
      runtimeInstanceId: "instance-1",
      fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
    });

    // Remove key deletes the credential BEFORE settlement, so a stop that needed it
    // could never complete.
    expect(JSON.stringify(fetchImpl.mock.calls)).not.toContain(SENTINEL_KEY);
  });

  it("omits the instance header when this tab never learned one", async () => {
    const fetchImpl = vi.fn(async () => json({ stopped: true }));

    await requestRuntimeStop({
      threadId: "thread-1",
      runtimeInstanceId: null,
      fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
    });

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.headers).toEqual({});
  });

  it.each([
    ["a confirmed stop", json({ stopped: true }), "stopped"],
    ["nothing active on the thread", json({ stopped: false }), "no_active_run"],
    ["a different launch instance", json({ stopped: false, detached: true }), "instance_mismatch"],
    ["an unknown agent id", json({ error: "Agent not found" }, 404), "unreachable"],
    ["a runtime failure", json({ error: "Failed to stop agent" }, 500), "unreachable"],
  ] as const)("classifies %s", async (_label, response, expected) => {
    const outcome = await requestRuntimeStop({
      threadId: "thread-1",
      runtimeInstanceId: "instance-1",
      fetchImpl: (async () => response) as unknown as typeof globalThis.fetch,
    });

    expect(outcome).toBe(expected);
  });

  it("classifies a transport failure without keeping any of its detail", async () => {
    const outcome = await requestRuntimeStop({
      threadId: "thread-1",
      runtimeInstanceId: "instance-1",
      fetchImpl: (async () => {
        throw new Error(`network died while sending ${SENTINEL_KEY}`);
      }) as unknown as typeof globalThis.fetch,
    });

    // A transport error object can carry the request; only the class survives.
    expect(outcome).toBe("unreachable");
  });

  it("treats only a real stop, or no run at all, as confirmation", () => {
    expect(isConfirmedStop("stopped")).toBe(true);
    expect(isConfirmedStop("not_attempted")).toBe(true);
    // Something else ended the run first and this app does not know what. That is
    // exactly the case the detachment rule exists for.
    expect(isConfirmedStop("no_active_run")).toBe(false);
    expect(isConfirmedStop("instance_mismatch")).toBe(false);
    expect(isConfirmedStop("unreachable")).toBe(false);
  });
});

describe("the launch instance identity", () => {
  it("reads /info once and caches it for the page lifetime", async () => {
    const fetchImpl = vi.fn(async () => json({ runtimeInstanceId: "launch-1" }));
    vi.stubGlobal("fetch", fetchImpl);

    expect(await primeRuntimeInstanceId()).toBe("launch-1");
    expect(await primeRuntimeInstanceId()).toBe("launch-1");

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [infoUrl] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(String(infoUrl)).toBe(`${COPILOT_RUNTIME_URL}/info`);
    expect(peekRuntimeInstanceId()).toBe("launch-1");
  });

  it("stays unknown when the handshake fails, so a turn detaches rather than guessing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );

    expect(await primeRuntimeInstanceId()).toBeNull();
    expect(peekRuntimeInstanceId()).toBeNull();
  });

  it("stays unknown when /info answers without an instance id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ agents: {} })),
    );

    expect(await primeRuntimeInstanceId()).toBeNull();
  });
});

describe("the active run handle", () => {
  it("is published for the controller and cleared when the run ends", () => {
    const abort = vi.fn();
    setActiveRunHandle({ threadId: "thread-1", runId: "run-1", abort });

    expect(readActiveRunHandle()).toMatchObject({ threadId: "thread-1", runId: "run-1" });

    setActiveRunHandle(null);
    expect(readActiveRunHandle()).toBeNull();
    // Publishing a handle does not abort anything by itself.
    expect(abort).not.toHaveBeenCalled();
  });
});
