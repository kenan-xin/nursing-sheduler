// Repository-owned validation of a command's RESULT (T03F1, review finding 8).
//
// WHY THE REPOSITORY VALIDATES. `patch_scenario` and `replace_scenario` are generic
// primitives: they shallow-apply whatever the caller hands over. `pickScenario`
// allowlists the KEYS, so a foreign field cannot reach the envelope — but nothing
// checked the VALUES. A caller could therefore persist `staff: "oops"` or a card
// missing its `weight`, and the damage only surfaced later, at serialization or on
// the next boot's sanitizer, by which point the invalid document was already the
// durable truth and the transaction that wrote it was long gone.
//
// Validating inside the write transaction turns that into a refused command: the
// transaction aborts, the envelope keeps its previous content, and the caller gets a
// typed failure it can surface. The repository is the last line that can still say
// no.
//
// The validator is the SAME structural contract the durable-record decoder already
// enforces (`sanitizePersistedScenario`), deliberately reused rather than
// re-specified: two independently-written definitions of "a valid scenario document"
// would drift, and the one that drifted would be this one.

import { sanitizePersistedScenario } from "@/lib/store/persistence";
import { RepositoryError } from "./errors";
import type { ScenarioSnapshot } from "./types";

/**
 * Throw `invalid_document` unless `snapshot`'s scenario is structurally valid.
 * Called inside the write transaction, so a rejection aborts the whole commit.
 */
export function assertValidScenarioSnapshot(
  snapshot: ScenarioSnapshot,
  detail: Record<string, unknown> = {},
): void {
  try {
    sanitizePersistedScenario({
      ...snapshot.scenario,
      backupFingerprint: snapshot.backupFingerprint,
    });
  } catch (error) {
    throw new RepositoryError(
      "invalid_document",
      `the command would persist an invalid scenario document: ${
        error instanceof Error ? error.message : String(error)
      }`,
      detail,
    );
  }
}
