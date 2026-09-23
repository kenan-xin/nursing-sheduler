import { describe, expect, it } from "vitest";

import {
  AI_ERROR_CREDENTIALS_REQUIRED,
  AI_KEY_HEADER as RUNTIME_KEY_HEADER,
  AI_MODEL_HEADER as RUNTIME_MODEL_HEADER,
  COPILOT_AGENT_ID,
  COPILOT_RUNTIME_BASE_PATH,
  OPENROUTER_BASE_URL as RUNTIME_OPENROUTER_BASE_URL,
  RUNTIME_INSTANCE_HEADER,
} from "./runtime/containment";
import {
  AI_AGENT_ID,
  AI_KEY_HEADER,
  AI_MODEL_HEADER,
  AI_RUNTIME_INSTANCE_HEADER,
  AI_SETUP_CODES,
  COPILOT_RUNTIME_URL,
  OPENROUTER_BASE_URL,
} from "./protocol";

// `protocol.ts` restates the runtime's wire constants so the browser bundle does
// not have to import a module whose whole job is a `process.env` side effect. The
// cost of that choice is a drift risk, and this suite is what pays it: a rename on
// either side fails here rather than producing requests the runtime rejects as
// unauthenticated.
describe("browser protocol constants match the runtime's own", () => {
  it.each([
    ["runtime mount", COPILOT_RUNTIME_URL, COPILOT_RUNTIME_BASE_PATH],
    ["agent id", AI_AGENT_ID, COPILOT_AGENT_ID],
    ["key header", AI_KEY_HEADER, RUNTIME_KEY_HEADER],
    ["model header", AI_MODEL_HEADER, RUNTIME_MODEL_HEADER],
    ["instance header", AI_RUNTIME_INSTANCE_HEADER, RUNTIME_INSTANCE_HEADER],
    ["OpenRouter base URL", OPENROUTER_BASE_URL, RUNTIME_OPENROUTER_BASE_URL],
  ])("%s", (_name, browser, runtime) => {
    expect(browser).toBe(runtime);
  });

  it("shares the runtime's credentials-required code", () => {
    expect(AI_SETUP_CODES.credentialsRequired).toBe(AI_ERROR_CREDENTIALS_REQUIRED);
  });

  it("keeps every setup code a stable opaque app string", () => {
    for (const code of Object.values(AI_SETUP_CODES)) {
      expect(code).toMatch(/^ai_[a-z_]+$/);
    }
  });
});
