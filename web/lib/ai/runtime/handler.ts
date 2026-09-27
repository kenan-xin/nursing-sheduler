import {
  AI_DETACH_REASON_INSTANCE_MISMATCH,
  AI_ERROR_CREDENTIALS_REQUIRED,
  AI_ERROR_MESSAGE_PART_REJECTED,
  AI_ERROR_REQUEST_TOO_LARGE,
  AI_KEY_HEADER,
  COPILOT_RUNTIME_BASE_PATH,
  MAX_RUN_REQUEST_BYTES,
  MAX_STOP_REQUEST_BYTES,
  RUNTIME_INSTANCE_HEADER,
} from "./containment";

// The contained entry point — the only module in the app that may name the runtime
// package. Import order here no longer carries any meaning.
import {
  CopilotRuntime,
  createCopilotRuntimeHandler,
  type CopilotRuntimeFetchHandler,
  type RouteInfo,
} from "./copilotkit-runtime";

import { assertSingleWebInstance } from "./deployment";
import { getRuntimeInstanceId } from "./instance-identity";
import {
  createAgentsFactory,
  hasOnlyTextParts,
  readAiCredentials,
  type OpenRouterAgentOptions,
} from "./openrouter-agent";
import { TransientAgentRunner } from "./transient-agent-runner";

// Same-origin CopilotKit v2 multi-route runtime, mounted under
// `/api/copilotkit/[[...slug]]`. Multi-route (not single-route) is what exposes the
// explicit run/connect/stop lifecycle the browser turn controller needs.

export type SchedulerCopilotRuntime = {
  readonly handler: CopilotRuntimeFetchHandler;
  readonly runner: TransientAgentRunner;
  readonly instanceId: string;
};

export type CreateSchedulerCopilotRuntimeOptions = OpenRouterAgentOptions & {
  /** Overridden by tests to simulate a restart under a different launch identity. */
  instanceId?: string;
};

export function createSchedulerCopilotRuntime(
  options: CreateSchedulerCopilotRuntimeOptions = {},
): SchedulerCopilotRuntime {
  assertSingleWebInstance();

  const instanceId = options.instanceId ?? getRuntimeInstanceId();
  const runner = new TransientAgentRunner({ instanceId });

  const runtime = new CopilotRuntime({
    agents: createAgentsFactory(options),
    runner,
    // The credential header is application input, not agent input. CopilotKit
    // forwards custom `x-*` headers onto the agent by default, which would put the
    // key on `agent.headers` and into `runner.connect`'s forwarded headers. Deny is
    // authoritative in CopilotKit's policy, so this cannot be widened by an
    // overlapping allow.
    forwardHeaders: { deny: [AI_KEY_HEADER] },
  });

  const handler = createCopilotRuntimeHandler({
    runtime,
    basePath: COPILOT_RUNTIME_BASE_PATH,
    mode: "multi-route",
    hooks: {
      onBeforeHandler: async ({ request, route }) => {
        const rejection = guardRoute(request, route, instanceId);
        // A thrown Response is CopilotKit's documented short-circuit: it still runs
        // the onResponse hook, so these bodies get the same containment headers.
        if (rejection) throw rejection;
        const limit = BODY_CEILINGS[route.method];
        if (limit === undefined || request.body === null) return request;
        const checked = await guardBody(request, limit, route.method === "agent/run");
        if (checked instanceof Response) throw checked;
        return checked;
      },
      onResponse: ({ response, route }) => containResponse(response, route, instanceId),
    },
  });

  return { handler, runner, instanceId };
}

/**
 * t0c9: the only CopilotKit routes the app's client calls. Every other one (suggest runs
 * the agent with any key and an unbounded body; transcribe, threads, and whatever a
 * future CopilotKit adds) answers 404.
 */
const ALLOWED_ROUTES: ReadonlySet<string> = new Set([
  "info",
  "agent/run",
  "agent/connect",
  "agent/stop",
]);

/**
 * t0c9: per-route body ceilings. connect carries the whole run input (the client resends
 * the thread on reconnect), so it shares the run ceiling; stop is sent with no body.
 */
const BODY_CEILINGS: Readonly<Record<string, number>> = {
  "agent/run": MAX_RUN_REQUEST_BYTES,
  "agent/connect": MAX_RUN_REQUEST_BYTES,
  "agent/stop": MAX_STOP_REQUEST_BYTES,
};

function guardRoute(request: Request, route: RouteInfo, instanceId: string): Response | null {
  if (!ALLOWED_ROUTES.has(route.method)) return jsonResponse({ error: "Not found" }, 404);

  if (route.method === "agent/run") {
    // The run route requires a validated key AND model. info/connect/stop do not.
    if (!readAiCredentials(request)) {
      return jsonResponse({ error: AI_ERROR_CREDENTIALS_REQUIRED }, 400);
    }
    return null;
  }

  if (route.method === "agent/stop") {
    // A stop aimed at a different launch instance is a detached settlement, not a
    // failure: report it as a normal not-stopped outcome so the browser closes its
    // epoch instead of retrying against a 404.
    const claimed = request.headers.get(RUNTIME_INSTANCE_HEADER);
    if (claimed && claimed !== instanceId) {
      return jsonResponse(
        { stopped: false, detached: true, reason: AI_DETACH_REASON_INSTANCE_MISMATCH },
        200,
      );
    }
  }

  // A mismatched `connect` is handled inside the runner, which answers it with the
  // same empty non-leaking stream as an unknown thread.
  return null;
}

/**
 * t0c9: a body, read ONCE through a byte ceiling; for a run, its message parts checked.
 *
 * Over `limit` -- by declared length, or by bytes counted as they stream when none is
 * declared -- the request is refused before anything past the ceiling is buffered. A
 * run's message part other than text is refused with a 400 (the agent factory checks
 * again on the converted input). CopilotKit then gets a new Request over the same
 * bytes. A body that is not JSON is CopilotKit's to reject. Responses carry codes only.
 */
async function guardBody(
  request: Request,
  limit: number,
  checkParts: boolean,
): Promise<Request | Response> {
  const tooLarge = () => jsonResponse({ error: AI_ERROR_REQUEST_TOO_LARGE }, 413);
  if (Number(request.headers.get("content-length")) > limit) return tooLarge();
  const bytes = await readCapped(request.body, limit);
  if (bytes === null) return tooLarge();
  if (checkParts && !runHasOnlyTextParts(bytes)) {
    return jsonResponse({ error: AI_ERROR_MESSAGE_PART_REJECTED }, 400);
  }
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: bytes,
    signal: request.signal,
  });
}

function runHasOnlyTextParts(bytes: Uint8Array): boolean {
  let messages: unknown;
  try {
    messages = (JSON.parse(new TextDecoder().decode(bytes)) as { messages?: unknown })?.messages;
  } catch {
    messages = null;
  }
  return !Array.isArray(messages) || hasOnlyTextParts(messages);
}

/** The whole stream, or null (and the stream cancelled) once it passes `limit` bytes. */
async function readCapped(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

/**
 * Applies the response-side containment contract to every runtime response,
 * including SSE streams and CopilotKit's own error bodies:
 *   - `Cache-Control: no-store` (CopilotKit's SSE default is the weaker `no-cache`);
 *   - no cookies, ever;
 *   - the launch-scoped instance id as bounded non-secret metadata.
 *
 * `/info` additionally carries the id in its JSON body, since that is the document
 * the browser reads before it has a turn to stamp.
 */
async function containResponse(
  response: Response,
  route: RouteInfo | undefined,
  instanceId: string,
): Promise<Response> {
  const headers = new Headers(response.headers);
  headers.delete("set-cookie");
  headers.set("cache-control", "no-store");
  headers.set(RUNTIME_INSTANCE_HEADER, instanceId);

  // Body rewriting is confined to /info. Reading any other body would consume the
  // SSE stream the browser is waiting on.
  if (route?.method === "info" && response.status === 200) {
    const info: unknown = await response.json();
    const body =
      typeof info === "object" && info !== null
        ? { ...info, runtimeInstanceId: instanceId }
        : { runtimeInstanceId: instanceId };
    headers.delete("content-length");
    return new Response(JSON.stringify(body), { status: response.status, headers });
  }

  return new Response(toByteStream(response.body), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * CopilotKit's SSE writer enqueues encoded events as STRINGS. A WHATWG `Response`
 * body must be a byte stream, so re-wrapping the response verbatim produces a
 * stream that throws "Received non-Uint8Array chunk" on read. Encoding here keeps
 * the containment re-wrap spec-compliant and leaves already-binary bodies untouched.
 */
function toByteStream(body: ReadableStream<unknown> | null): ReadableStream<Uint8Array> | null {
  if (!body) return null;

  const encoder = new TextEncoder();
  return body.pipeThrough(
    new TransformStream<unknown, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(
          typeof chunk === "string" ? encoder.encode(chunk) : (chunk as Uint8Array),
        );
      },
    }),
  );
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let singleton: SchedulerCopilotRuntime | undefined;

/** Process-wide runtime for the mounted route. One per launch, matching the id. */
export function getSchedulerCopilotRuntime(): SchedulerCopilotRuntime {
  singleton ??= createSchedulerCopilotRuntime();
  return singleton;
}
