import {
  AI_ERROR_CREDENTIALS_REQUIRED,
  AI_KEY_HEADER,
  AI_MODEL_HEADER,
  COPILOT_AGENT_ID,
  OPENROUTER_BASE_URL,
} from "./containment";

import { createOpenAI } from "@ai-sdk/openai";
import type { AbstractAgent } from "@ag-ui/client";
// The contained entry point — see `copilotkit-runtime.ts`.
import {
  BuiltInAgent,
  convertMessagesToVercelAISDKMessages,
  convertToolsToVercelAITools,
  type AgentsFactory,
} from "./copilotkit-runtime";
import { streamText, type ToolSet } from "ai";

// Request-scoped BYO OpenRouter agent (tech-plan "Credential and model transport").
//
// `BuiltInAgent` factory mode is what makes the transient credential possible:
// classic mode would need the key at construction time, while factory mode hands
// the application the request's `AbortSignal` and lets it own the model call. The
// key is read from the request headers, captured ONLY in this request's factory
// closure, and dropped when the request ends. It is never converted to messages,
// forwarded properties, tools, or model-visible state, and `handler.ts` denies it
// from CopilotKit's inbound header forwarding so it cannot reach the agent either.

export type AiCredentials = {
  readonly apiKey: string;
  readonly model: string;
};

/**
 * Reads the transient credential pair. Returns null when either is absent: info,
 * connect, and stop must stay callable WITHOUT a key so "Remove key" can delete the
 * browser credential first and stop the work second.
 */
export function readAiCredentials(request: Request): AiCredentials | null {
  const apiKey = request.headers.get(AI_KEY_HEADER)?.trim();
  const model = request.headers.get(AI_MODEL_HEADER)?.trim();
  if (!apiKey || !model) return null;
  return { apiKey, model };
}

export type OpenRouterAgentOptions = {
  /**
   * Transport override. Tests inject a fixture so the suite is deterministic and
   * makes no provider call; production leaves it unset and uses global fetch.
   */
  fetch?: typeof globalThis.fetch;
};

/**
 * Stable, message-only failure. `BuiltInAgent` surfaces a factory throw as an
 * AG-UI RUN_ERROR carrying `error.message`, so the message must be an app code --
 * never an upstream provider body, and never anything derived from the key.
 */
export class AiRuntimeError extends Error {
  constructor(code: string) {
    super(code);
    this.name = "AiRuntimeError";
  }
}

export function createOpenRouterAgent(
  request: Request,
  options: OpenRouterAgentOptions = {},
): AbstractAgent {
  const credentials = readAiCredentials(request);

  return new BuiltInAgent({
    type: "aisdk",
    factory: ({ input, abortSignal }) => {
      // Defence in depth. `handler.ts` already rejects a keyless /run at the HTTP
      // boundary; this keeps the invariant true for any other caller of the factory.
      if (!credentials) throw new AiRuntimeError(AI_ERROR_CREDENTIALS_REQUIRED);

      const openrouter = createOpenAI({
        apiKey: credentials.apiKey,
        baseURL: OPENROUTER_BASE_URL,
        ...(options.fetch ? { fetch: options.fetch } : {}),
      });

      return streamText({
        // `.chat()` explicitly: the provider's default callable resolves to OpenAI's
        // Responses API, which OpenRouter's /api/v1 does not implement.
        model: openrouter.chat(credentials.model),
        messages: convertMessagesToVercelAISDKMessages(input.messages),
        tools: toAppToolSet(convertToolsToVercelAITools(input.tools)),
        abortSignal,
        // Serial tool calls. Each frontend tool handler revalidates turn/lease epoch
        // before publishing, which a parallel batch would let it skip.
        providerOptions: { openai: { parallelToolCalls: false } },
      });
    },
  });
}

/**
 * Bridges CopilotKit's converted tools onto this app's `ai` types.
 *
 * The locked family resolves TWO copies of `ai@6.0.104` -- one peered to zod 3
 * (`@copilotkit/runtime` declares `zod: ^3.23.3`) and one peered to zod 4 (this app).
 * The code is identical; only the zod-branded `Schema` types differ nominally, so
 * `ToolSet` is structurally the same and nominally incompatible. The values cross
 * the boundary safely at RUNTIME because the AI SDK brands schemas with
 * `Symbol.for("vercel.ai.schema")` -- a GLOBAL registry symbol, shared across
 * copies by design. `package-family.test.ts` pins both facts, and
 * `copilot-runtime.test.ts` asserts the converted tool actually reaches the
 * provider request body, so a future upgrade that breaks this fails loudly rather
 * than silently dropping every tool definition.
 */
function toAppToolSet(tools: unknown): ToolSet {
  return tools as ToolSet;
}

/** Per-request agent resolution. CopilotKit calls this on info/run/connect/stop. */
export function createAgentsFactory(options: OpenRouterAgentOptions = {}): AgentsFactory {
  return ({ request }) => ({ [COPILOT_AGENT_ID]: createOpenRouterAgent(request, options) });
}
