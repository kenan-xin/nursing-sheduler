// @vitest-environment jsdom
// T03F1 finding 1 (identity half) — a duplicated tab must not share its opener's
// writer identity.
//
// `sessionStorage` is per-tab BUT IS COPIED into a tab created by `window.open`,
// `target=_blank`, or "Duplicate tab". Two live controllers then present the same
// tab id, and every mechanism that distinguishes tabs collapses: acquisition renews
// the lease IN PLACE rather than refusing, cross-tab hints are self-filtered by tab
// id, and neither tab ever goes read-only — two writers on one scenario under one
// epoch, which is precisely what the single-writer lease exists to prevent.
//
// Reload and duplication are indistinguishable from durable state alone, so the
// discriminator is whether the other instance is still ALIVE. These tests pin both
// directions: a reload keeps its identity (so it can reclaim its own lease), and a
// live-peer collision mints a fresh one.

import { beforeEach, describe, expect, it } from "vitest";
import { releaseTabIdentity, resolveTabIdentity } from "./authority";

const TAB_ID_KEY = "nurse-scheduler/tabId";

beforeEach(() => {
  releaseTabIdentity();
  sessionStorage.clear();
});

describe("tab identity", () => {
  it("mints and persists an id on a first boot", async () => {
    const minted = await resolveTabIdentity();

    expect(minted).toBeTruthy();
    expect(sessionStorage.getItem(TAB_ID_KEY)).toBe(minted);
  });

  it("a RELOAD keeps the stored id, so the tab can reclaim its own lease", async () => {
    const first = await resolveTabIdentity();
    // The page went away: its identity responder closed with it.
    releaseTabIdentity();

    const afterReload = await resolveTabIdentity();

    expect(afterReload).toBe(first);
  });

  it("a DUPLICATE tab mints a fresh id instead of sharing its opener's", async () => {
    // The original stays live, holding the id and answering probes.
    const original = await resolveTabIdentity();

    // The duplicate boots with a COPY of the same stored id. `resolveTabIdentity`
    // installs a new holder for whatever it settles on, so capture the answer before
    // the module-level responder is replaced.
    sessionStorage.setItem(TAB_ID_KEY, original);
    const duplicate = await resolveTabIdentity();

    expect(duplicate).not.toBe(original);
    // ...and the fresh id is what the duplicate persists for its own reloads.
    expect(sessionStorage.getItem(TAB_ID_KEY)).toBe(duplicate);
  });
});
