// The scenario-free credential and tool probe (T04).
//
// WHAT A PASS PROVES: this key can reach this model through OpenRouter, and the
// model honoured a forced tool call. That is exactly the pair of facts setup and
// repair depend on. It proves nothing about FUTURE availability, and the UI must
// not present it as such.
//
// WHAT THE PROBE CARRIES: a fixed nonsense prompt and one trivial tool. No
// scenario, no conversation, no route context, nothing derived from the user's
// data. That is what makes it safe to run from a Settings screen before the user
// has decided anything about their document.
//
// WHAT LEAVES THE SERVER: one of the stable codes in `AI_SETUP_CODES`. Upstream
// bodies are read only to CLASSIFY -- an OpenRouter error body can echo request
// content and account detail, so it is never forwarded, logged, or wrapped.

import { AI_SETUP_CODES, OPENROUTER_BASE_URL, type AiSetupCode } from "@/lib/ai/protocol";

export type ProbeResult = { ok: true } | { ok: false; code: AiSetupCode };

/** The one tool the probe asks for. Trivial, and deliberately not domain-shaped. */
const PROBE_TOOL = {
  type: "function" as const,
  function: {
    name: "report_ready",
    description: "Report that the tool contract works. Call it with no arguments.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
};

function classifyStatus(status: number, body: string): AiSetupCode {
  if (status === 401 || status === 403) return AI_SETUP_CODES.credentialsRejected;
  if (status === 402 || status === 429) return AI_SETUP_CODES.providerDeclined;
  if (status === 404) return AI_SETUP_CODES.modelUnavailable;
  if (status === 400) {
    // A 400 is OpenRouter's answer both to "no such model" and to "this model
    // cannot do what you asked for", and the two need different guidance. The
    // body is inspected ONLY to pick between two of our own codes; none of it is
    // returned.
    const lowered = body.toLowerCase();
    if (lowered.includes("tool") || lowered.includes("function")) {
      return AI_SETUP_CODES.modelLacksTools;
    }
    return AI_SETUP_CODES.modelUnavailable;
  }
  if (status >= 500) return AI_SETUP_CODES.providerUnreachable;
  return AI_SETUP_CODES.probeFailed;
}

/** Whether the completion actually produced a tool call. */
function calledTheTool(payload: unknown): boolean {
  const choices = (payload as { choices?: unknown })?.choices;
  if (!Array.isArray(choices) || choices.length === 0) return false;
  const calls = (choices[0] as { message?: { tool_calls?: unknown } })?.message?.tool_calls;
  return Array.isArray(calls) && calls.length > 0;
}

export interface ProbeInput {
  apiKey: string;
  model: string;
  fetchImpl?: typeof globalThis.fetch;
  signal?: AbortSignal;
}

export async function probeCredentials(input: ProbeInput): Promise<ProbeResult> {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;

  let response: Response;
  try {
    response = await fetchImpl(`${OPENROUTER_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.apiKey}`,
        "content-type": "application/json",
      },
      ...(input.signal ? { signal: input.signal } : {}),
      body: JSON.stringify({
        model: input.model,
        messages: [{ role: "user", content: "Call report_ready." }],
        tools: [PROBE_TOOL],
        // Forced, so a model that merely CAN call tools has to actually do it --
        // an unforced probe passes on a chatty reply that proves nothing.
        tool_choice: { type: "function", function: { name: PROBE_TOOL.function.name } },
        parallel_tool_calls: false,
        max_tokens: 32,
        stream: false,
      }),
    });
  } catch {
    return { ok: false, code: AI_SETUP_CODES.providerUnreachable };
  }

  if (!response.ok) {
    // Read as text, not JSON: a gateway may answer with HTML, and a parse failure
    // here would turn a classifiable rejection into an opaque one.
    const body = await response.text().catch(() => "");
    return { ok: false, code: classifyStatus(response.status, body) };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, code: AI_SETUP_CODES.probeFailed };
  }

  if (!calledTheTool(payload)) return { ok: false, code: AI_SETUP_CODES.modelLacksTools };
  return { ok: true };
}
