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

import { classifyVersionCompatibility } from "@/lib/version/version-compat";
import { currentAppVersion } from "./app-version";
import { projectScenarioDocument } from "./canonical";
import { importScenarioValue, parseScenarioYaml } from "./import-scenario";
import { validateScenario, type ScenarioValidationIssue } from "./serialize";
import {
  checkWorkspaceGuidedIntegrity,
  checkWorkspaceIdentityIntegrity,
  classifyWorkspaceSource,
  normalizeWorkspaceToImportTarget,
  parseWorkspaceV1Document,
  workspaceRootSchema,
} from "./workspace";
import type { CanonicalScenarioDocument, ImportNormalizationTarget } from "./types";
import type { z } from "zod";

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
  // 0. Dual-format dispatch (DL12 §4). A `workspaceVersion` scalar routes to the
  //    Workspace V1 loader; its absence keeps the legacy strict/import path below,
  //    which is unchanged. Only the discriminator picks the path — a Workspace file
  //    never enters the legacy schema, and a legacy file never enters Workspace V1.
  const source = classifyWorkspaceSource(raw);
  if (source.kind === "v1") return prepareWorkspaceLoad(raw);
  if (source.kind === "unsupported") {
    return {
      target: null,
      doc: null,
      issues: [
        { path: "workspaceVersion", message: `Unsupported workspaceVersion: ${source.display}.` },
      ],
      warnings: [],
    };
  }

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

/**
 * The Workspace V1 branch of the load pipeline. Parse → strict structural schema →
 * identity-preserving normalization. A Workspace backup preserves incomplete work
 * (DL12 §2), so it loads and restores authoring state even when it is not
 * optimize-ready: only a YAML syntax error or a structural schema violation
 * (unknown field, wrong type) blocks. Full readiness is enforced later, at Optimize.
 */
function prepareWorkspaceLoad(raw: string): PrepareScenarioLoadResult {
  let parsed: unknown;
  try {
    parsed = parseWorkspaceV1Document(raw);
  } catch (error) {
    return {
      target: null,
      doc: null,
      issues: [{ path: "", message: `YAML parse error: ${(error as Error).message}` }],
      warnings: [],
    };
  }
  const result = workspaceRootSchema.safeParse(parsed);
  if (!result.success) {
    return { target: null, doc: null, issues: workspaceZodIssues(result.error), warnings: [] };
  }
  // Identity integrity must block hydration even though incomplete work otherwise
  // loads (DL12 §2): a duplicate preference `workspaceId` (across cards or request
  // cells) or a duplicate Guided pin id/source would collide on one durable id or
  // corrupt the one-pin-per-source invariant once carried into the store. A missing
  // preference id is already rejected structurally by the schema above.
  const identityIssues = [
    ...checkWorkspaceIdentityIntegrity(result.data),
    ...checkWorkspaceGuidedIntegrity(result.data),
  ];
  if (identityIssues.length > 0) {
    return {
      target: null,
      doc: null,
      issues: identityIssues.map(workspaceIssueToValidation),
      warnings: [],
    };
  }
  return {
    target: normalizeWorkspaceToImportTarget(result.data),
    doc: null,
    issues: [],
    warnings: [],
  };
}

/** Flatten a structured Workspace issue to the load pipeline's `ScenarioValidationIssue`. */
function workspaceIssueToValidation(issue: {
  path: Array<string | number>;
  message: string;
}): ScenarioValidationIssue {
  return { path: issue.path.map(String).join("."), message: issue.message };
}

/** Flatten a Workspace schema error to `ScenarioValidationIssue`s (unknown keys expanded). */
function workspaceZodIssues(error: z.ZodError): ScenarioValidationIssue[] {
  return error.issues.flatMap((issue) => {
    if (issue.code === "unrecognized_keys") {
      return issue.keys.map((key) => ({
        path: [...issue.path, key].map(String).join("."),
        message: `Unrecognized field: ${key}.`,
      }));
    }
    return [{ path: issue.path.map(String).join("."), message: issue.message }];
  });
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
 * The subset of compatibility tiers that stage a confirm-before-load dialog
 * (Decision A). The shared `classifyVersionCompatibility` (T2) returns six tiers;
 * `identical` / `compatible` / `indeterminate` load silently (no modal), so the
 * load flow only ever sees these three — each carries its own FR-SL-19 copy.
 */
export type VersionConfirmStatus = "missing" | "dirty" | "incompatible";

/**
 * Map the imported file's `appVersion` (vs the current build) onto the load-flow
 * confirm decision via the shared major.minor classifier (T2). Returns `null` when
 * the load is silent — `identical` / `compatible` (same major.minor line) /
 * `indeterminate` (no tag to judge) — or the confirm status for the three tiers
 * that warrant a modal. Grammar normalization (optional leading `v`) and sentinel
 * folding live in the shared util, so legacy bare-semver YAML stays comparable.
 */
export function classifyLoadVersion(
  fileVersion: string | undefined,
  current: string = currentAppVersion(),
): VersionConfirmStatus | null {
  switch (classifyVersionCompatibility(fileVersion, current)) {
    case "missing":
      return "missing";
    case "dirty":
      return "dirty";
    case "incompatible":
      return "incompatible";
    default:
      return null;
  }
}
