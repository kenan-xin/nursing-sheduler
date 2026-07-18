// Pure pre-commit load seam (T17b, tech-plan §4 decision 2).
//
// The load-bearing mechanism of the T17b Load half: NOTHING touches the store
// until validation passes and (if needed) the user confirms. This module owns
// the pure projection + preflight; the real state replacement lives in the
// store's `loadScenario`, called later (T17b UI) on the UNCHANGED target only
// after this gate passes and the version confirm resolves.
//
//   parse YAML → lenient importScenarioValue (LEAVE/OFF normalize) →
//   projectImportTarget → validateScenario (producer preflight, which runs
//   validateContractedHoursContract) → { target, doc, issues, warnings }
//
// It mutates nothing and never throws into its caller: a YAML syntax error, an
// import/schema failure, and a producer/contracted V-message all come back
// through `issues`; non-blocking advanced-syntax survivors come back through
// `warnings`. The returned `target` is the keyless import target, byte-identical
// to what `importScenarioValue` produced, so the later `loadScenario(target)` can
// allocate its own fresh card identity without collision.

import { currentAppVersion } from "./app-version";
import { projectScenarioDocument } from "./canonical";
import { importScenarioValue, parseScenarioYaml } from "./import-scenario";
import { validateScenario, type ScenarioValidationIssue } from "./serialize";
import type { CanonicalScenarioDocument, ImportNormalizationTarget } from "./types";

/** The pure pre-commit load result. `issues` empty ⇒ safe to commit via `loadScenario`. */
export interface PrepareScenarioLoadResult {
  /**
   * The unchanged keyless import target, handed to the later `loadScenario`.
   * `null` only when parse or import failed (there is no target to load).
   */
  target: ImportNormalizationTarget | null;
  /**
   * The canonical projection that was validated (canonicalized on success). `null`
   * when a prior stage (parse / import) failed before a document could be built.
   */
  doc: CanonicalScenarioDocument | null;
  /**
   * Blocking problems, in one channel: a YAML syntax error (path `""`) OR the
   * import-schema / producer / contracted-hours V-messages. Empty ⇒ load may proceed.
   */
  issues: ScenarioValidationIssue[];
  /**
   * Non-blocking advanced-syntax survivors (deduped): backend reference/preference
   * shapes preserved on import but outside the web UI editing subset. Never blocks.
   */
  warnings: string[];
}

/**
 * Pure, deterministic projection of the KEYLESS import target to a canonical
 * document. Reuses the generalized canonical projection directly on the target —
 * it never invents card uids (`crypto.randomUUID`), so the same target always
 * projects to an identical document. The doc is used only for validation; the
 * canonical hash strips card uids regardless, and real identity is assigned later
 * by the store's `loadScenario` on the unchanged target.
 */
export function projectImportTarget(target: ImportNormalizationTarget): CanonicalScenarioDocument {
  return projectScenarioDocument(target);
}

/**
 * Run the pure pre-commit load pipeline over a raw YAML string, mutating nothing.
 * See the module header for the pipeline; the store is untouched by construction
 * (this function has no store handle).
 */
export function prepareScenarioLoad(raw: string): PrepareScenarioLoadResult {
  // 1. Parse (YAML 1.2). A syntax error is the first, blocking channel.
  let parsed: unknown;
  try {
    parsed = parseScenarioYaml(raw);
  } catch (error) {
    return {
      target: null,
      doc: null,
      issues: [{ path: "", message: `YAML parse error: ${(error as Error).message}` }],
      warnings: [],
    };
  }

  // 2. Lenient import — accepts every backend-valid form; LEAVE/OFF selectors are
  //    normalized into leave/off matrix cells inside `normalizeImport`. Structural
  //    / schema failures return the second issue channel (no target, no doc).
  const imported = importScenarioValue(parsed);
  if (!imported.ok) {
    return { target: null, doc: null, issues: imported.issues, warnings: [] };
  }
  const { target } = imported;

  // 3. Project the keyless target to a canonical document (pure, no uids). Import
  //    normalization guarantees a request cell never carries an OFF/LEAVE day-state
  //    selector, so the projection's invariant guard cannot fire here; the try
  //    keeps the pre-commit gate from ever throwing into its caller regardless.
  let doc: CanonicalScenarioDocument;
  try {
    doc = projectImportTarget(target);
  } catch (error) {
    return {
      target,
      doc: null,
      issues: [{ path: "", message: (error as Error).message }],
      warnings: [],
    };
  }

  // 4. Producer preflight (runs `validateContractedHoursContract` transitively).
  const validation = validateScenario(doc);
  const warnings = collectImportWarnings(target);
  if (!validation.ok) {
    return { target, doc, issues: validation.issues, warnings };
  }
  return { target, doc: validation.document, issues: [], warnings };
}

// ---------------------------------------------------------------------------
// Advanced-syntax survivor warnings (FR-SL-25 / FR-SL-29, deduped per FR-SL-31)
// ---------------------------------------------------------------------------

// Verbatim FR-SL message suffixes; the leading label identifies the surviving
// field. Labels omit the per-card index so genuinely identical survivors collapse
// to a single banner line (FR-SL-31 `[...new Set(...)]`, AC-SL-20).
const ADVANCED_SYNTAX_SUFFIX =
  " uses advanced backend reference syntax. It was preserved and may not be editable in the web UI without replacing it.";
const BACKEND_ONLY_SUFFIX =
  " uses backend-compatible syntax that is outside the web UI editing subset. It was preserved and may be replaced if edited in the web UI.";

/** A normalized reference value is a *nested* tree when it is an array holding any array. */
function hasNestedReferenceIds(value: unknown): boolean {
  return Array.isArray(value) && value.some((element) => Array.isArray(element));
}

/**
 * Collect non-blocking advanced-syntax warnings from the normalized import target,
 * deduped by exact string. V12 (FR-SL-25): a preference selector carrying a nested
 * reference tree. V13 (FR-SL-29): an UNMARKED shift count with an array expression
 * or target (a marked contracted-hours count uses that shape by design — FR-SL-28a).
 */
function collectImportWarnings(target: ImportNormalizationTarget): string[] {
  const warnings: string[] = [];
  const advanced = (label: string): void => void warnings.push(`${label}${ADVANCED_SYNTAX_SUFFIX}`);
  const backendOnly = (label: string): void => void warnings.push(`${label}${BACKEND_ONLY_SUFFIX}`);
  const cards = target.cardsByKind;

  for (const card of cards.requirements) {
    if (hasNestedReferenceIds(card.shiftType)) advanced("shift type requirement · shiftType");
  }
  for (const card of cards.successions) {
    if (hasNestedReferenceIds(card.pattern)) advanced("shift type successions · pattern");
  }
  for (const card of cards.affinities) {
    if (hasNestedReferenceIds(card.people1)) advanced("shift affinity · people1");
    if (hasNestedReferenceIds(card.people2)) advanced("shift affinity · people2");
    if (hasNestedReferenceIds(card.shiftTypes)) advanced("shift affinity · shiftTypes");
  }
  for (const card of cards.coverings) {
    if (hasNestedReferenceIds(card.preceptors)) advanced("shift type covering · preceptors");
    if (hasNestedReferenceIds(card.preceptees)) advanced("shift type covering · preceptees");
    if (hasNestedReferenceIds(card.shiftTypes)) advanced("shift type covering · shiftTypes");
  }
  for (const card of cards.counts) {
    if (card.tag === "contracted_hours") continue;
    if (Array.isArray(card.expression) || Array.isArray(card.target)) {
      backendOnly("shift count · expression/target");
    }
  }

  return [...new Set(warnings)];
}

// ---------------------------------------------------------------------------
// Version-integrity classifier (FR-SL-19 input for the T17b confirm modal)
// ---------------------------------------------------------------------------

/**
 * The version-gate outcome, keyed on the imported file's `appVersion` vs the
 * current build. `match` needs no dialog; the other three drive a confirm-before-load.
 */
export type ImportVersionStatus = "match" | "missing" | "dirty" | "mismatch";

/**
 * Classify the imported file's `appVersion` against the current build version.
 * Pure; mirrors FR-SL-19's exact order and comparison: `missing` when absent,
 * `dirty` when it ends with `-dirty` (checked BEFORE plain mismatch), `mismatch`
 * on exact string inequality, else `match`. The comparison is exact-string; it
 * does not parse semver parts (FR-SL-20).
 */
export function classifyImportVersion(
  fileVersion: string | undefined,
  current: string = currentAppVersion(),
): ImportVersionStatus {
  if (!fileVersion) return "missing";
  if (fileVersion.endsWith("-dirty")) return "dirty";
  if (fileVersion !== current) return "mismatch";
  return "match";
}
