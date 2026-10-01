import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SINGAPORE_HOLIDAYS, type SingaporeHolidayEntry } from "@/lib/dates/holidays-sg";
import { getRosterDb } from "@/lib/store/dexie-storage";
import { fetchSingaporeHolidayList, LAST_GOOD_HOLIDAYS_KEY } from "./singapore-holidays";

const ROW_2028: SingaporeHolidayEntry = {
  date: "2028-08-09",
  name: "National Day",
  isObserved: false,
};
const LIVE = [...SINGAPORE_HOLIDAYS, ROW_2028];
const saved = (entries: readonly SingaporeHolidayEntry[], bundle = SINGAPORE_HOLIDAYS) =>
  getRosterDb().keyval.put({
    key: LAST_GOOD_HOLIDAYS_KEY,
    value: JSON.stringify({ bundle: JSON.stringify(bundle), entries }),
  });

const fetchMock = vi.fn();

beforeEach(async () => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  await getRosterDb().keyval.delete(LAST_GOOD_HOLIDAYS_KEY);
});

afterEach(() => vi.unstubAllGlobals());

describe("fetchSingaporeHolidayList: live -> last good -> bundled", () => {
  it("uses the live list and keeps it as the last good copy", async () => {
    fetchMock.mockResolvedValue(Response.json({ source: "live", entries: LIVE }));
    expect(await fetchSingaporeHolidayList()).toEqual(LIVE);
    const row = await getRosterDb().keyval.get(LAST_GOOD_HOLIDAYS_KEY);
    expect(JSON.parse(row!.value).entries).toEqual(LIVE);
  });

  it("falls back to the last good copy when the server answers the bundle", async () => {
    await saved(LIVE);
    fetchMock.mockResolvedValue(Response.json({ source: "bundled", entries: SINGAPORE_HOLIDAYS }));
    expect(await fetchSingaporeHolidayList()).toContainEqual(ROW_2028);
  });

  it("ignores a last good copy saved under an older bundle", async () => {
    // The old bundle's 2028 row rode along in the live answer; the new bundle must win.
    await saved(LIVE, SINGAPORE_HOLIDAYS.slice(1));
    fetchMock.mockRejectedValue(new TypeError("offline"));
    expect(await fetchSingaporeHolidayList()).toBe(SINGAPORE_HOLIDAYS);
  });

  it("falls back to the bundle with no last good copy, or a corrupt one", async () => {
    fetchMock.mockRejectedValue(new TypeError("offline"));
    expect(await fetchSingaporeHolidayList()).toBe(SINGAPORE_HOLIDAYS);
    await getRosterDb().keyval.put({ key: LAST_GOOD_HOLIDAYS_KEY, value: '[{"date":1}]' });
    expect(await fetchSingaporeHolidayList()).toBe(SINGAPORE_HOLIDAYS);
  });

  it("ignores an off-contract route answer", async () => {
    fetchMock.mockResolvedValue(Response.json({ source: "live", entries: [{ date: "x" }] }));
    expect(await fetchSingaporeHolidayList()).toBe(SINGAPORE_HOLIDAYS);
  });
});
