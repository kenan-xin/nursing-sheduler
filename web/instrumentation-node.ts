import { applyRuntimeContainmentEnv } from "@/lib/ai/runtime/containment";
import { assertSingleWebInstance } from "@/lib/ai/runtime/deployment";
import { assertBffConfigValid } from "@/lib/backend";

// Node.js-only half of the `instrumentation` hook. It is loaded exclusively via
// `await import("./instrumentation-node")` from the `NEXT_RUNTIME === "nodejs"`
// branch of `register()`, so `process.exit` (a Node API unavailable in the Edge
// Runtime) never lands in the Edge compilation and Turbopack raises no warning.
//
// IMPORTANT: a THROWN error here does NOT reliably terminate the Next 16
// standalone server — it degrades to a live process that binds and serves 500s.
// So on invalid config we log the actionable message and `process.exit(1)`, which
// fires wherever the Node server initializes (`node server.js`, `pnpm start`,
// `next dev`) BEFORE the port is bound. That makes fail-fast genuinely fatal.
export function registerNode(): void {
  // Before anything can import the CopilotKit runtime: its telemetry client
  // snapshots the opt-out env at module load. `lib/ai/runtime/containment.ts` also
  // applies it as an import-time side effect, so a route that loads before this
  // hook is still contained; doing it here as well means no import path can miss it.
  applyRuntimeContainmentEnv();

  try {
    // Phase-1 AI containment supports exactly one Next web instance. A deployment
    // that claims otherwise is refused at boot, not discovered when a browser turn
    // silently detaches in production.
    assertSingleWebInstance();
    assertBffConfigValid();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[startup] fatal — refusing to start the server: ${message}`);
    process.exit(1);
  }
}
