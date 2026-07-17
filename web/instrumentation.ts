// Next.js server-start hook (App Router `instrumentation`). `register()` runs once
// when a server instance boots and must complete before the server handles
// requests. Next skips this during `next build`
// (NEXT_PHASE === "phase-production-build"), so a production build with unset vars
// still succeeds; only a running server enforces the requirement.
//
// Next invokes `register()` in BOTH the Node.js and Edge runtimes, and Turbopack
// statically compiles this module for each. The fail-fast path uses `process.exit`
// (a Node-only API), so it lives in `./instrumentation-node` and is loaded only via
// the dynamic import below under the Node runtime — keeping it out of the Edge
// compilation. See https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation
export async function register(): Promise<void> {
  // The Edge runtime also calls register(); config validation is a Node concern.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { registerNode } = await import("./instrumentation-node");
  registerNode();
}
