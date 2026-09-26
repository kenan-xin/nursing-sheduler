// @vitest-environment jsdom

// useWorkingRoster reads what an OLDER build stored (bead g1p): a roster-file/1 row
// in IndexedDB has no `borrowed`, and every lens reads `borrowed.length`.

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { rosterStorage } from "@/lib/store";
import { fixtureRosterDocument } from "@/lib/roster/test-fixtures";
import { useWorkingRoster } from "./use-working-roster";

beforeEach(async () => {
  await rosterStorage.clearRosterData();
});

afterEach(cleanup);

describe("useWorkingRoster", () => {
  it("upgrades a stored roster-file/1 working roster to roster-file/2", async () => {
    const { borrowed: _dropped, ...v1 } = await fixtureRosterDocument();
    const outcome = await rosterStorage.promoteDocumentToWorking({
      document: { ...v1, schemaVersion: "roster-file/1" },
      // Stored as an older build wrote it: no validation, no upgrade.
      validate: (value) => ({ ok: true as const, document: value }),
      expectedWorkingRevision: null,
      expectedClearEpoch: await rosterStorage.getClearEpoch(),
    });
    expect(outcome.status).toBe("promoted");

    const { result } = renderHook(() => useWorkingRoster());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.document).toMatchObject({
      schemaVersion: "roster-file/2",
      borrowed: [],
    });
  });
});
