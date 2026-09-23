import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AI_KEY_HEADER, AI_MODEL_HEADER, AI_SETUP_CODES } from "@/lib/ai/protocol";
import { FALLBACK_MODELS } from "./catalog";
import {
  CATALOG_TTL_MS,
  handleModelCatalogRequest,
  handleProbeRequest,
  resetCatalogMemo,
} from "./routes";

// The sentinel is the whole point of this suite: it is a string that must appear on
// exactly ONE wire -- the Authorization header of the provider request -- and on no
// response, header, or log line anywhere.
const SENTINEL = "sk-or-SENTINEL-DO-NOT-LOG-0001";
const MODEL = "anthropic/claude-sonnet-4.5";

let consoleOutput: string[] = [];
beforeEach(() => {
  resetCatalogMemo();
  consoleOutput = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      consoleOutput.push(args.map((a) => (a instanceof Error ? a.stack : String(a))).join(" "));
    });
  }
});
afterEach(() => {
  vi.restoreAllMocks();
});

function probeRequest(headers: Record<string, string>): Request {
  return new Request("https://app.test/api/ai/openrouter/test", { method: "POST", headers });
}

function credentialHeaders(): Record<string, string> {
  return { [AI_KEY_HEADER]: SENTINEL, [AI_MODEL_HEADER]: MODEL };
}

/** A provider response that did call the forced tool. */
function toolCallCompletion(): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            role: "assistant",
            tool_calls: [{ id: "c1", type: "function", function: { name: "report_ready" } }],
          },
        },
      ],
    }),
    { status: 200 },
  );
}

describe("model catalog route", () => {
  it("is no-store and sets no cookie", async () => {
    const response = await handleModelCatalogRequest({
      fetchImpl: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
    });

    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("serves the built-in list when OpenRouter is unreachable", async () => {
    const response = await handleModelCatalogRequest({
      fetchImpl: (async () => {
        throw new Error("down");
      }) as unknown as typeof fetch,
    });

    const body = (await response.json()) as { source: string; models: unknown[] };
    expect(body.source).toBe("fallback");
    expect(body.models).toHaveLength(FALLBACK_MODELS.length);
  });

  it("memoizes a live catalog for the TTL rather than refetching per visit", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [{ id: "a/x", supported_parameters: ["tools"] }] }), {
          status: 200,
        }),
    );
    let clock = 1_000;

    await handleModelCatalogRequest({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => clock,
    });
    await handleModelCatalogRequest({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => clock,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    clock += CATALOG_TTL_MS + 1;
    await handleModelCatalogRequest({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => clock,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does NOT memoize a fallback, so one transient failure cannot pin the offline list", async () => {
    const fetchImpl = vi
      .fn<() => Promise<Response>>()
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ id: "a/x", supported_parameters: ["tools"] }] }), {
          status: 200,
        }),
      );

    const first = (await (
      await handleModelCatalogRequest({ fetchImpl: fetchImpl as unknown as typeof fetch })
    ).json()) as { source: string };
    const second = (await (
      await handleModelCatalogRequest({ fetchImpl: fetchImpl as unknown as typeof fetch })
    ).json()) as { source: string };

    expect(first.source).toBe("fallback");
    expect(second.source).toBe("catalog");
  });
});

describe("probe route", () => {
  it("refuses without both a key and a model, without calling the provider", async () => {
    const fetchImpl = vi.fn();

    const incomplete: Record<string, string>[] = [
      {},
      { [AI_KEY_HEADER]: SENTINEL },
      { [AI_MODEL_HEADER]: MODEL },
      { [AI_KEY_HEADER]: "   ", [AI_MODEL_HEADER]: MODEL },
    ];

    for (const headers of incomplete) {
      const response = await handleProbeRequest(probeRequest(headers), {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        ok: false,
        code: AI_SETUP_CODES.credentialsRequired,
      });
    }

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("passes when the model actually calls the forced tool", async () => {
    const fetchImpl = vi.fn(async () => toolCallCompletion());

    const response = await handleProbeRequest(probeRequest(credentialHeaders()), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(await response.json()).toEqual({ ok: true });

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    // Forced, single, and carrying no scenario or conversation: a probe that a
    // chatty non-tool reply could pass would prove nothing.
    expect(body.tool_choice).toEqual({
      type: "function",
      function: { name: "report_ready" },
    });
    expect(body.parallel_tool_calls).toBe(false);
    expect(JSON.stringify(body.messages)).not.toMatch(/nurse|shift|roster|leave/i);
  });

  it("fails a model that answers without calling the tool", async () => {
    const response = await handleProbeRequest(probeRequest(credentialHeaders()), {
      fetchImpl: (async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: "sure!" } }] }), {
          status: 200,
        })) as unknown as typeof fetch,
    });

    expect(await response.json()).toEqual({ ok: false, code: AI_SETUP_CODES.modelLacksTools });
  });

  it.each([
    [401, "unauthorized", AI_SETUP_CODES.credentialsRejected],
    [403, "forbidden", AI_SETUP_CODES.credentialsRejected],
    [402, "insufficient credits", AI_SETUP_CODES.providerDeclined],
    [429, "rate limited", AI_SETUP_CODES.providerDeclined],
    [404, "no such model", AI_SETUP_CODES.modelUnavailable],
    [400, "model does not support tool use", AI_SETUP_CODES.modelLacksTools],
    [400, "unknown parameter", AI_SETUP_CODES.modelUnavailable],
    [502, "bad gateway", AI_SETUP_CODES.providerUnreachable],
    [418, "teapot", AI_SETUP_CODES.probeFailed],
  ])("classifies %i as %s -> %s", async (status, upstreamBody, code) => {
    const response = await handleProbeRequest(probeRequest(credentialHeaders()), {
      fetchImpl: (async () => new Response(upstreamBody, { status })) as unknown as typeof fetch,
    });

    expect(await response.json()).toEqual({ ok: false, code });
  });

  it("answers 200 even for a rejected probe, so the client renders guidance rather than retrying", async () => {
    const response = await handleProbeRequest(probeRequest(credentialHeaders()), {
      fetchImpl: (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch,
    });
    expect(response.status).toBe(200);
  });

  it("never returns or logs the upstream body", async () => {
    const upstream = "UPSTREAM-DETAIL account=ward-manager@example.test prompt-echo=hello";
    const response = await handleProbeRequest(probeRequest(credentialHeaders()), {
      fetchImpl: (async () => new Response(upstream, { status: 400 })) as unknown as typeof fetch,
    });

    const text = await response.text();
    expect(text).not.toContain("UPSTREAM-DETAIL");
    expect(text).not.toContain("ward-manager@example.test");
    expect(consoleOutput.join("\n")).not.toContain("UPSTREAM-DETAIL");
  });

  it("puts the sentinel key on the provider request and nowhere else", async () => {
    const fetchImpl = vi.fn(async () => toolCallCompletion());

    const response = await handleProbeRequest(probeRequest(credentialHeaders()), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const surfaces = [
      JSON.stringify([...response.headers.entries()]),
      await response.text(),
      consoleOutput.join("\n"),
    ];
    for (const surface of surfaces) {
      expect(surface).not.toContain(SENTINEL);
    }
    expect(response.headers.get("set-cookie")).toBeNull();

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${SENTINEL}`);
    // The credential is the credential, never content.
    expect(String(init.body)).not.toContain(SENTINEL);
  });

  it("forwards the request's abort signal so a cancelled test stops billing", async () => {
    const controller = new AbortController();
    const seen: (AbortSignal | null | undefined)[] = [];
    const request = new Request("https://app.test/api/ai/openrouter/test", {
      method: "POST",
      headers: credentialHeaders(),
      signal: controller.signal,
    });

    await handleProbeRequest(request, {
      fetchImpl: (async (_url: unknown, init: RequestInit) => {
        seen.push(init.signal);
        return toolCallCompletion();
      }) as unknown as typeof fetch,
    });

    expect(seen[0]).toBeDefined();
    expect(seen[0]?.aborted).toBe(false);
    controller.abort();
    expect(seen[0]?.aborted).toBe(true);
  });

  it("reports an unreachable provider rather than throwing", async () => {
    const response = await handleProbeRequest(probeRequest(credentialHeaders()), {
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });

    expect(await response.json()).toEqual({
      ok: false,
      code: AI_SETUP_CODES.providerUnreachable,
    });
  });
});
