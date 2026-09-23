// The single F2×F3 convergence point.
//
// F2 owns capture orchestration, durability, and cleanup authority. It owns NO
// roster document schema, submission version, container validation, baseline
// hash, or overlay normalization — all of that is F3's. This module is the one
// place where the two meet, so the seam is a single import rather than a
// scattering of assumptions about F3's shape.
//
// Nothing here re-declares a version or re-validates a container: the submission
// envelope version is re-exported from F3 verbatim, and `assembleRosterDocument`
// performs the version check, container parse, axis alignment, baseline hash, and
// whole-document validation itself.

// DIRECT LEAF IMPORTS, not the `@/lib/roster` barrel. The barrel's export surface
// reaches back into this module (via roster-clear → @/lib/optimize), so importing it
// here closed a real ESM cycle. The owners are unchanged — F3 still owns assembly and
// the submission version — this only stops loading F3's unrelated public exports.
import { assembleRosterDocument } from "@/lib/roster/assemble";
import { ROSTER_SUBMISSION_SCHEMA_VERSION } from "@/lib/roster/types";
import type { BuildCandidateDocument } from "./roster-capture";

/**
 * The submission-envelope version stamped onto every staged snapshot.
 *
 * Re-exported from F3, never re-declared. A literal copy here would be a second
 * version authority that could silently drift out of step with the assembler that
 * actually enforces it.
 */
export const ROSTER_SUBMISSION_VERSION = ROSTER_SUBMISSION_SCHEMA_VERSION;

/**
 * The build stamp recorded as document provenance. It never gates compatibility
 * (F3 treats it as provenance only), so an unset build falls back to a stable
 * marker rather than failing assembly for a reason unrelated to the roster.
 */
export function rosterAppBuild(): string {
  const build = process.env.NEXT_PUBLIC_APP_VERSION;
  return typeof build === "string" && build.length > 0 ? build : "dev";
}

/**
 * The production candidate builder: F3's assembler, adapted to F2's build result.
 *
 * Every rejection it can return is NON-RETRYABLE by construction. `assembleRosterDocument`
 * fails closed only on structural facts about the inputs already in hand — an
 * unsupported container or submission version, axes that do not line up, a grid
 * that does not validate. Repeating the call with the same container and the same
 * frozen bytes cannot change any of those, so the capture gate resolves the run
 * instead of parking it behind a Retry button that could never succeed. A THROWN
 * error is different, and the gate classifies that as retryable on its own.
 */
export const productionCandidateBuilder: BuildCandidateDocument = async (input) => {
  const result = await assembleRosterDocument({
    container: input.container,
    submission: input.snapshot,
    frozenXlsx: input.frozenXlsx,
    appBuild: rosterAppBuild(),
  });
  return result.ok
    ? { ok: true, document: result.document }
    : { ok: false, retryable: false, reason: result.reason };
};
