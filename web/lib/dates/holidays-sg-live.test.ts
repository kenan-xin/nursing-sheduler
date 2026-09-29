import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/public-holidays/route";
import { SINGAPORE_HOLIDAYS } from "./holidays-sg";
import {
  loadSingaporeHolidays,
  parseUpstreamHolidays,
  resetSingaporeHolidayCache,
  SG_HOLIDAYS_TTL_MS,
  SG_HOLIDAYS_URL,
} from "./holidays-sg-live";

// data.gov.sg datastore_search shape, as answered for this resource (2026-09-29).
function upstream(records: { date: string; holiday: string }[], total = records.length) {
  return {
    success: true,
    result: {
      resource_id: "d_8ef23381f9417e4d4254ee8b4dcdb176",
      fields: [],
      records: records.map((r, i) => ({ _id: i + 1, day: "Monday", ...r })),
      total,
      limit: 1000,
    },
  };
}

const LIVE_2028 = [
  { date: "2028-01-01", holiday: "New Year's Day" },
  { date: "2028-01-03", holiday: "New Year's Day (Observed)" },
];

const fetchMock = vi.fn();

beforeEach(() => {
  resetSingaporeHolidayCache();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("parseUpstreamHolidays", () => {
  it("strips (Observed) into isObserved and keeps names verbatim, sorted", () => {
    expect(
      parseUpstreamHolidays(
        upstream([
          { date: "2028-01-03", holiday: "New Year’s Day (Observed)" },
          { date: "2028-01-01", holiday: "New Year’s Day" },
        ]),
      ),
    ).toEqual([
      { date: "2028-01-01", name: "New Year’s Day", isObserved: false },
      { date: "2028-01-03", name: "New Year’s Day", isObserved: true },
    ]);
  });

  it.each([
    ["success false", { success: false, error: {} }],
    ["not a calendar date", upstream([{ date: "2028-02-30", holiday: "x" }])],
    ["empty name", upstream([{ date: "2028-01-01", holiday: " " }])],
    ["no rows", upstream([])],
    ["an incomplete page", upstream(LIVE_2028, 1500)],
  ])("rejects %s", (_label, body) => {
    expect(() => parseUpstreamHolidays(body)).toThrow();
  });
});

describe("loadSingaporeHolidays", () => {
  it("answers live rows merged over the bundle (live years win, bundle fills gaps)", async () => {
    fetchMock.mockResolvedValue(Response.json(upstream(LIVE_2028)));
    const result = await loadSingaporeHolidays(0);
    expect(fetchMock).toHaveBeenCalledWith(SG_HOLIDAYS_URL, expect.anything());
    expect(result.source).toBe("live");
    expect(result.entries.slice(-2)).toEqual([
      { date: "2028-01-01", name: "New Year's Day", isObserved: false },
      { date: "2028-01-03", name: "New Year's Day", isObserved: true },
    ]);
    expect(result.entries.slice(0, -2)).toEqual(SINGAPORE_HOLIDAYS);
  });

  it.each([
    ["a network error", () => Promise.reject(new TypeError("fetch failed"))],
    ["a timeout", () => Promise.reject(new DOMException("timed out", "TimeoutError"))],
    ["HTTP 429", () => Promise.resolve(new Response("{}", { status: 429 }))],
    ["an invalid body", () => Promise.resolve(Response.json({ success: true }))],
  ])("falls back to the bundle on %s, uncached", async (_label, impl) => {
    fetchMock.mockImplementation(impl);
    expect(await loadSingaporeHolidays(0)).toEqual({
      source: "bundled",
      entries: SINGAPORE_HOLIDAYS,
    });
    await loadSingaporeHolidays(1);
    expect(fetchMock).toHaveBeenCalledTimes(2); // a failure is retried next request
  });

  it("caches the live list for a day, then refetches", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(Response.json(upstream(LIVE_2028))));
    await loadSingaporeHolidays(1_000);
    await loadSingaporeHolidays(1_000 + SG_HOLIDAYS_TTL_MS - 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await loadSingaporeHolidays(1_000 + SG_HOLIDAYS_TTL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never fetches when SG_HOLIDAYS_OFFLINE=1", async () => {
    vi.stubEnv("SG_HOLIDAYS_OFFLINE", "1");
    expect((await loadSingaporeHolidays(0)).source).toBe("bundled");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("GET /api/public-holidays", () => {
  it("answers 200 with the bundled flag when upstream is down", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body.source).toBe("bundled");
    expect(body.entries).toHaveLength(SINGAPORE_HOLIDAYS.length);
  });
});
