// ubb regression: a scenario persisted BEFORE the FR-RI-09/D7 repair (2by.1) can
// still hold the blank history slot a pre-D7 shift-type delete left behind. The
// file-load paths (legacy YAML import, Workspace V1 restore) repair it on load via
// `normalizePerson` -> `truncateHistoryAtBlankEntries`; the boot-time durable
// IndexedDB repository read path had no normalize step, so the blank reached the
// producer and core, which reject it (`Unknown shift type ID in history: ''`).
//
// This seeds that exact durable shape through the shipped write path, then reloads
// through the REAL authority bring-up, and asserts the boot result equals what the
// file-load path produces for the same blank.
import "fake-indexeddb/auto";
import { afterEach, expect, it } from "vitest";
import { stringify } from "yaml";
import { toCanonicalScenarioDocument } from "@/lib/scenario/canonical";
import { prepareScenarioLoad } from "@/lib/scenario/prepare-scenario-load";
import { makeValidUiState } from "@/lib/scenario/test-fixtures";
import { scenarioCommands, useScenarioStore } from "@/lib/store";
import {
  clearTestAuthority,
  drainScenarioCommands,
  freshAuthorityDbName,
  installTestAuthority,
} from "@/lib/store/test-authority";

afterEach(() => {
  clearTestAuthority();
});

/** The blank a pre-D7 shift-type delete left in Alice's history. */
const BLANKED_HISTORY = ["N", "", "D"];

it("repairs a blanked history slot on the boot read path, matching the file-load path", async () => {
  // What the FILE-LOAD path (legacy YAML import) produces for the same blank.
  const doc = toCanonicalScenarioDocument(makeValidUiState());
  doc.people.items.find((person) => person.id === "Alice")!.history = [...BLANKED_HISTORY];
  const fileLoad = prepareScenarioLoad(stringify(doc, { version: "1.2" as const }));
  const expected = fileLoad.target!.staff.find((person) => person.id === "Alice")!.history;
  // History is right-anchored: only the suffix newer than the blank survives.
  expect(expected).toEqual(["D"]);

  // Seed the durable envelope with the same blank, as a pre-fix build stored it.
  const databaseName = freshAuthorityDbName();
  const first = await installTestAuthority({ databaseName });
  await scenarioCommands.mutate(makeValidUiState());
  await drainScenarioCommands();

  const scenarioId = (await first.db.scenarioEnvelopes.toArray())[0].scenarioId;
  const envelope = (await first.db.scenarioEnvelopes.get(scenarioId))!;
  const staff = envelope.scenario.staff.map((person) =>
    person.id === "Alice" ? { ...person, history: [...BLANKED_HISTORY] } : person,
  );
  await first.db.scenarioEnvelopes.put({
    ...envelope,
    scenario: { ...envelope.scenario, staff },
  });
  clearTestAuthority();
  first.db.close();

  // The reload: the new build brings the saved workspace up from IndexedDB through
  // the real boot read path.
  await installTestAuthority({ databaseName, tabId: first.tabId });

  const alice = useScenarioStore.getState().staff.find((person) => person.id === "Alice")!;
  expect(alice.history).toEqual(expected);
});
