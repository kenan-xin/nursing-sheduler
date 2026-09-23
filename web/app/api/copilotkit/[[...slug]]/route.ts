import { getSchedulerCopilotRuntime } from "@/lib/ai/runtime/handler";

// Same-origin CopilotKit v2 runtime mount (T01 containment spike).
//
// Node runtime, not Edge: the transient AgentRunner holds active run state in
// process memory, and the Phase-1 topology is exactly one long-lived Next instance.
// `force-dynamic` keeps every request request-scoped -- the BYO credential arrives
// as a header and nothing here may ever be cached or prerendered.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function handle(request: Request): Promise<Response> {
  return getSchedulerCopilotRuntime().handler(request);
}

export const GET = handle;
export const POST = handle;
