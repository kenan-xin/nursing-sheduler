import { handleSummaryRequest } from "@/lib/ai/openrouter/routes";

// Older-turn summary (bead ypo). Node runtime and `force-dynamic`: the BYO credential
// arrives as a request header, so nothing here may be cached or reused.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return handleSummaryRequest(request);
}
