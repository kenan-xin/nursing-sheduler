import { loadSingaporeHolidays } from "@/lib/dates/holidays-sg-live";

// GET /api/public-holidays — Singapore public holidays: the live data.gov.sg list
// merged over the bundled snapshot, or the bundled list with `source: "bundled"`
// when the live fetch fails (lib/dates/holidays-sg-live.ts). Never an error status.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return Response.json(await loadSingaporeHolidays(), {
    headers: { "cache-control": "no-store" },
  });
}
