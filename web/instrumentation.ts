// Next.js server-start hook (App Router `instrumentation`). `register()` runs once
// when a server instance boots and must complete before the server handles
// requests. Next skips this during `next build`
// (NEXT_PHASE === "phase-production-build"), so a production build with unset vars
// still succeeds; only a running server enforces the requirement.
//
// IMPORTANT: a THROWN error from `register()` does NOT reliably terminate the Next
// 16 standalone server — it degrades to a live process that binds and serves 500s.
// So on invalid config we log the actionable message and `process.exit(1)`, which
// fires wherever the Node server initializes (`node server.js`, `pnpm start`,
// `next dev`) BEFORE the port is bound. That makes fail-fast genuinely fatal.
export async function register(): Promise<void> {
  // The Edge runtime also calls register(); config validation is a Node concern.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { assertBffConfigValid } = await import("@/lib/backend");
  try {
    assertBffConfigValid();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[bff-config] fatal — refusing to start the server: ${message}`);
    process.exit(1);
  }
}
