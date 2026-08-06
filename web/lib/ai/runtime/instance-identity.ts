import { randomUUID } from "node:crypto";

// Launch-scoped runtime instance identity (tech-plan "Runtime topology").
//
// Minted once per Node process. A restart mints a new one, so a browser turn that
// captured the old id detaches rather than silently reattaching to a process that
// has already lost its transient run state. It is bounded non-secret metadata: a
// random UUID carrying no credential, prompt, scenario, or user identity.

let instanceId: string | undefined;

export function getRuntimeInstanceId(): string {
  instanceId ??= randomUUID();
  return instanceId;
}

/**
 * Test-only reset so a suite can simulate a process restart. Production code never
 * calls this — the id must be stable for the life of the launch.
 */
export function resetRuntimeInstanceIdForTest(): void {
  instanceId = undefined;
}
