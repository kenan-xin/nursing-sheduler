import { handleModelCatalogRequest } from "@/lib/ai/openrouter/routes";

// Tool-capable OpenRouter model catalog (T04). Node runtime and `force-dynamic`:
// the handler holds a process-local 15-minute memo, and nothing about this route
// may be prerendered or served from a shared cache.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(): Promise<Response> {
  return handleModelCatalogRequest();
}
