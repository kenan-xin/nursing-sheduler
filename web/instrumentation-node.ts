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
  try {
    assertBffConfigValid();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[bff-config] fatal — refusing to start the server: ${message}`);
    process.exit(1);
  }
}
