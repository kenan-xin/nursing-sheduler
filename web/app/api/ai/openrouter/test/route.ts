import { handleProbeRequest } from "@/lib/ai/openrouter/routes";

// Scenario-free credential and tool probe (T04). Node runtime and `force-dynamic`:
// the BYO credential arrives as a request header, so nothing here may be cached,
// prerendered, or reused across requests.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return handleProbeRequest(request);
}
