// @vitest-environment jsdom
// Workspace V1 cross-language differential gate (T17r, tech-plan §4/§7) — the
// AUTHORITY over the independent TypeScript and Python Workspace implementations.
// It runs both directions of the shared contract through the vendored, pinned T19
// backend (`oracle.py` → real `canonicalize_submission`):
//
//   1. TS dump → Python strict ≡ strict producer. A frontend-authored Workspace
//      YAML (`serializeWorkspace`), pushed through the real pre-job boundary,
//      projects to the same strict scheduling model as the frontend's own strict
//      producer projection (`serializeScenario`).
//   2. Python fixtures import equivalently in TS. Externally-authored Workspace
//      YAML (weights omitted, disabled/guided authoring metadata present) that the
//      Python boundary accepts also converts in TS to a strict document Python
//      then canonicalizes to the same model.
//   3. Full authoring state hydrates through the REAL frontend load path. External
//      Workspace fixtures are driven through the production dispatcher
//      (`prepareScenarioLoad`) and a real store Load transaction (`loadScenario`),
//      and every durable authoring field — card/cell identity, disabled flags, all
//      five Guided kinds and their fields, incomplete dates, and export layout — is
//      compared against INDEPENDENT hand-authored goldens (T17r review P1). Strict
//      projection is then compared SEPARATELY (direction 1/2), so a same-bug-on-
//      both-sides regression in the shared TS mapping cannot hide behind it.
//   4. Version scalar dispatch parity. A bidirectional matrix proves the TS
//      classifier and the real Python `ruamel.yaml` loader select V1 for exactly
//      the same `workspaceVersion` scalar forms (`1`, `+1`, `01`, radix, `!!int`,
//      anchors/aliases, comments) and reject the same others (`1.0`, quoted,
//      boolean, null, unsupported integers).
//   5. Rejection-category parity. Incomplete, unsupported-version, unknown-field
//      (including inside a disabled record), and duplicate-Guided-source Workspaces
//      are rejected by both sides in the same normative category.
//
// Fail-closed like the sibling harness: gated on `RUN_DIFFERENTIAL=1`, and when
// gated a missing/broken backend is a hard failure, never a green skip.

import "fake-indexeddb/auto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { serializeScenario, serializeCanonicalDocument } from "../serialize";
import { convertWorkspaceForOptimize, serializeWorkspace } from "../workspace";
import { prepareScenarioLoad } from "../prepare-scenario-load";
import { makeValidUiState } from "../test-fixtures";
import type { ScenarioUiState } from "../types";
import {
  drainScenarioPersist,
  loadScenario,
  resetToNewScenario,
  useHotStore,
  useScenarioStore,
} from "@/lib/store";

const ORACLE = resolve(dirname(fileURLToPath(import.meta.url)), "oracle.py");
const PYTHON = process.env.PYTHON ?? "python3";
const GATED = !!process.env.RUN_DIFFERENTIAL;

interface OracleResponse {
  ok: boolean;
  error?: string;
  errorType?: string;
  errorCode?: string;
  equivalent?: boolean;
  appVersion?: { strict: unknown; workspace: unknown };
  issues?: Array<{ path: Array<string | number>; code: string; message: string }>;
}

function callOracle(request: object): OracleResponse {
  const result = spawnSync(PYTHON, [ORACLE], { input: JSON.stringify(request), encoding: "utf-8" });
  if (result.status !== 0) {
    throw new Error(`oracle exited ${result.status}: ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout) as OracleResponse;
}

const READY_PROBE = `workspaceVersion: 1
apiVersion: alpha
dates:
  range:
    startDate: 2025-01-01
    endDate: 2025-01-01
people:
  items:
    - id: alice
shiftTypes:
  items:
    - id: day
preferences:
  - workspaceId: r1
    enabled: true
    type: at most one shift per day
`;

function backendAvailable(): boolean {
  if (!GATED) return false;
  try {
    return callOracle({ op: "workspace_canonical", yaml: READY_PROBE }).ok === true;
  } catch {
    return false;
  }
}

const AVAILABLE = GATED && backendAvailable();

// --- Frontend UI-state variants exercised in direction 1 ---------------------

function withDisabledRequirement(): ScenarioUiState {
  const state = makeValidUiState();
  state.cardsByKind.requirements[0].disabled = true;
  return state;
}

function withGuidedPin(): ScenarioUiState {
  const state = makeValidUiState();
  // Pin the requirement card (uid "r1") into a Guided rule; the workspace emits
  // `guidedRules`, and both sides must strip it before solving.
  state.guidedRulePins = [
    {
      id: "g1",
      constraintKind: "requirements",
      constraintId: "r1",
      category: "Coverage",
      quickFields: [],
    },
  ];
  return state;
}

function withUnicodeAndInfinity(): ScenarioUiState {
  const state = makeValidUiState();
  state.meta.description = "Ward 7B — 病棟";
  // A hard shift-count constraint carries an infinite weight (.inf) end to end.
  state.cardsByKind.counts = [
    {
      uid: "h1",
      person: "ALL",
      countDates: "ALL",
      countShiftTypes: ["D", "E"],
      countShiftTypeCoefficients: [
        ["D", 1],
        ["E", 1],
      ],
      expression: "x = T",
      target: 5,
      weight: Infinity,
      tag: "contracted_hours",
      policy: "exact",
    },
  ];
  return state;
}

const STATE_VARIANTS: Record<string, () => ScenarioUiState> = {
  base: makeValidUiState,
  "disabled requirement (filtered)": withDisabledRequirement,
  "guided pin (stripped)": withGuidedPin,
  "unicode + infinite weight": withUnicodeAndInfinity,
};

// --- Externally-authored Workspace fixtures exercised in direction 2 ---------
// Weights are deliberately omitted (backend defaults), disabled/guided authoring
// metadata is present, and dates/refs are ready — the Python-flavoured shape.

const READY_FIXTURES: Record<string, string> = {
  "converged legacy equivalent (disabled + guided)": `workspaceVersion: 1
apiVersion: alpha
dates:
  range:
    startDate: 2025-01-01
    endDate: 2025-01-01
people:
  items:
    - id: alice
    - id: bob
shiftTypes:
  items:
    - id: day
preferences:
  - workspaceId: r1
    enabled: true
    type: at most one shift per day
  - workspaceId: r2
    enabled: true
    type: shift type requirement
    shiftType: day
    requiredNumPeople: 1
  - workspaceId: r3
    enabled: false
    type: shift request
    person: alice
    date: 2025-01-01
    shiftType: day
guidedRules:
  - id: g1
    constraintKind: requirements
    constraintId: r2
    category: Coverage
    quickFields: [requiredNumPeople]
appVersion: 1.0.0
`,
  "unicode description + infinite request weight": `workspaceVersion: 1
apiVersion: alpha
description: "Ward 7B — 病棟"
dates:
  range:
    startDate: 2025-01-01
    endDate: 2025-01-01
people:
  items:
    - id: 病棟
shiftTypes:
  items:
    - id: day
preferences:
  - workspaceId: r1
    enabled: true
    type: at most one shift per day
  - workspaceId: r2
    enabled: true
    type: shift request
    person: 病棟
    date: 2025-01-01
    shiftType: LEAVE
    weight: .inf
appVersion: 2.0.0
`,
};

describe.skipIf(!GATED)("workspace differential — backend availability (fail-closed)", () => {
  it("Python + vendored server boundary are importable", () => {
    expect(AVAILABLE).toBe(true);
  });
});

describe.skipIf(!AVAILABLE)(
  "workspace differential — TS dump → Python strict ≡ strict producer",
  () => {
    for (const [name, build] of Object.entries(STATE_VARIANTS)) {
      it(`serializeWorkspace ≡ serializeScenario through canonicalize_submission (${name})`, () => {
        const state = build();
        const res = callOracle({
          op: "workspace_equiv",
          strict: serializeScenario(state),
          workspace: serializeWorkspace(state),
        });
        expect(res.ok).toBe(true);
        expect(res.equivalent).toBe(true);
      });
    }
  },
);

describe.skipIf(!AVAILABLE)(
  "workspace differential — Python fixtures import equivalently in TS",
  () => {
    for (const [name, fixture] of Object.entries(READY_FIXTURES)) {
      it(`TS convert → strict ≡ Python canonicalize_submission (${name})`, () => {
        const result = convertWorkspaceForOptimize(fixture);
        expect(result.status).toBe("ok");
        if (result.status !== "ok") return;
        const res = callOracle({
          op: "workspace_equiv",
          strict: serializeCanonicalDocument(result.document),
          workspace: fixture,
        });
        expect(res.ok).toBe(true);
        expect(res.equivalent).toBe(true);
        // The Python pre-job boundary accepts the identical fixture bytes.
        expect(callOracle({ op: "workspace_canonical", yaml: fixture }).ok).toBe(true);
      });
    }
  },
);

// --- Direction 3: full authoring state through the real dispatcher + store -----
// These are Python-authored Workspace fixtures with an INDEPENDENT, hand-authored
// expected authoring state. Each is driven through the production dispatcher and a
// real store Load transaction; the resulting durable store state is compared to the
// golden. Strict projection is compared SEPARATELY (via the oracle) so the two
// checks cannot mask each other.

/** A rich, optimize-ready Workspace exercising every card kind, all five Guided
 *  kinds and their fields, all three request-cell kinds, and export layout. */
const FULL_AUTHORING = `workspaceVersion: 1
apiVersion: alpha
description: T05 fixture
dates:
  range:
    startDate: 2026-05-14
    endDate: 2026-05-20
  groups:
    - id: FirstTwo
      members:
        - 2026-05-14
        - 2026-05-15
people:
  items:
    - id: Alice
      history:
        - D
    - id: Bob
  groups:
    - id: Seniors
      members:
        - Alice
        - Bob
shiftTypes:
  items:
    - id: D
      description: Day
      durationMinutes: 420
      startTime: 09:00
      endTime: 17:00
      restMinutes: 60
    - id: E
      description: Evening
    - id: N
      description: Night
  groups:
    - id: DayOrEvening
      members:
        - D
        - E
preferences:
  - workspaceId: max-one-shift-per-day
    enabled: true
    type: at most one shift per day
    description: one per day
  - workspaceId: r1
    enabled: true
    type: shift type requirement
    shiftType: D
    requiredNumPeople: 1
    qualifiedPeople: ALL
    date: ALL
    weight: -1
  - workspaceId: s1
    enabled: true
    type: shift type successions
    person: ALL
    pattern:
      - - D
        - N
    weight: 5
  - workspaceId: n1
    enabled: true
    type: shift count
    person: ALL
    countDates: ALL
    countShiftTypes:
      - D
    expression: x >= 0
    target: 0
    weight: 3
  - workspaceId: a1
    enabled: true
    type: shift affinity
    date: ALL
    people1:
      - Alice
    people2:
      - Bob
    shiftTypes:
      - D
    weight: 4
  - workspaceId: v1
    enabled: true
    type: shift type covering
    date: ALL
    preceptors:
      - Alice
    preceptees:
      - Bob
    shiftTypes:
      - D
    weight: 2
  - workspaceId: c1
    enabled: true
    type: shift request
    person: Alice
    date: 2026-05-14
    shiftType: LEAVE
    weight: .inf
  - workspaceId: c2
    enabled: true
    type: shift request
    person: Bob
    date: 2026-05-15
    shiftType: D
    weight: 2
  - workspaceId: c3
    enabled: true
    type: shift request
    person: Bob
    date: 2026-05-16
    shiftType: OFF
    weight: 1
guidedRules:
  - id: g-req
    constraintKind: requirements
    constraintId: r1
    category: Coverage
    quickFields:
      - requiredNumPeople
    description: cover D
  - id: g-succ
    constraintKind: successions
    constraintId: s1
    category: Pattern
    quickFields:
      - pattern
  - id: g-cnt
    constraintKind: counts
    constraintId: n1
    category: Load
    quickFields:
      - expression
  - id: g-aff
    constraintKind: affinities
    constraintId: a1
    category: Pairing
    quickFields:
      - people1
      - people2
  - id: g-cov
    constraintKind: coverings
    constraintId: v1
    category: Mentoring
    quickFields:
      - preceptors
export:
  formatting:
    - type: row
      people:
        - Alice
      backgroundColor: "#ff0000"
appVersion: unknown
`;

/** A structurally-valid backup with a DISABLED requirement and a Guided pin on the
 *  enabled one — the disabled record survives to authoring state but is filtered
 *  out of the strict projection. */
const DISABLED_RECORD = `workspaceVersion: 1
apiVersion: alpha
dates:
  range:
    startDate: 2026-05-14
    endDate: 2026-05-20
people:
  items:
    - id: Alice
    - id: Bob
shiftTypes:
  items:
    - id: D
    - id: E
preferences:
  - workspaceId: max-one-shift-per-day
    enabled: true
    type: at most one shift per day
  - workspaceId: r1
    enabled: true
    type: shift type requirement
    shiftType: D
    requiredNumPeople: 1
  - workspaceId: r2
    enabled: false
    type: shift type requirement
    shiftType: E
    requiredNumPeople: 2
guidedRules:
  - id: g-req
    constraintKind: requirements
    constraintId: r1
    category: Coverage
    quickFields:
      - requiredNumPeople
appVersion: unknown
`;

/** An incomplete backup (null dates): a Workspace preserves in-progress authoring
 *  state, so the frontend loads it while the Python optimize boundary is not_ready. */
const INCOMPLETE_BACKUP = `workspaceVersion: 1
apiVersion: alpha
dates:
  range:
    startDate: null
    endDate: null
people:
  items:
    - id: Alice
shiftTypes:
  items:
    - id: D
preferences:
  - workspaceId: r1
    enabled: true
    type: shift type requirement
    shiftType: D
    requiredNumPeople: 1
guidedRules: []
appVersion: unknown
`;

/** Drive a fixture through the production dispatcher + a real store Load, returning
 *  the resulting durable authoring state. Resets the store first so each load starts
 *  from a clean empty workspace. */
async function hydrateThroughStore(fixture: string) {
  const prepared = prepareScenarioLoad(fixture);
  expect(prepared.issues).toEqual([]);
  expect(prepared.target).not.toBeNull();
  await resetToNewScenario(useScenarioStore, useHotStore);
  loadScenario(useScenarioStore, useHotStore, prepared.target!);
  return useScenarioStore.getState();
}

describe.skipIf(!AVAILABLE)(
  "workspace differential — full authoring state hydrates through the real load path",
  () => {
    afterEach(async () => {
      await resetToNewScenario(useScenarioStore, useHotStore);
      await drainScenarioPersist(useScenarioStore);
    });

    it("every durable field survives the production dispatcher + store Load (independent golden)", async () => {
      const state = await hydrateThroughStore(FULL_AUTHORING);

      expect(state.meta.description).toBe("T05 fixture");
      expect(state.meta.apiVersion).toBe("alpha");
      expect(state.rangeStart).toBe("2026-05-14");
      expect(state.rangeEnd).toBe("2026-05-20");
      expect(state.staff).toMatchObject([{ id: "Alice", history: ["D"] }, { id: "Bob" }]);
      expect(state.staffGroups).toMatchObject([{ id: "Seniors", members: ["Alice", "Bob"] }]);
      expect(state.shifts).toMatchObject([{ id: "D" }, { id: "E" }, { id: "N" }]);
      expect(state.shiftGroups).toMatchObject([{ id: "DayOrEvening", members: ["D", "E"] }]);
      expect(state.dateGroups).toMatchObject([
        { id: "FirstTwo", members: ["2026-05-14", "2026-05-15"] },
      ]);
      expect(state.maxOneShiftPerDay).toMatchObject({ description: "one per day" });

      // Card identity + bodies, per kind. Non-positional uid comes from workspaceId.
      expect(state.cardsByKind.requirements).toMatchObject([
        { uid: "r1", shiftType: "D", requiredNumPeople: 1 },
      ]);
      expect(state.cardsByKind.successions).toMatchObject([
        { uid: "s1", person: "ALL", pattern: [["D", "N"]] },
      ]);
      expect(state.cardsByKind.counts).toMatchObject([
        {
          uid: "n1",
          person: "ALL",
          countDates: "ALL",
          countShiftTypes: ["D"],
          expression: "x >= 0",
          target: 0,
        },
      ]);
      expect(state.cardsByKind.affinities).toMatchObject([
        { uid: "a1", date: "ALL", people1: ["Alice"], people2: ["Bob"], shiftTypes: ["D"] },
      ]);
      expect(state.cardsByKind.coverings).toMatchObject([
        { uid: "v1", date: "ALL", preceptors: ["Alice"], preceptees: ["Bob"], shiftTypes: ["D"] },
      ]);

      // Every request cell keeps its durable, non-positional uid and its kind.
      expect(state.reqData).toMatchObject([
        { uid: "c1", kind: "leave", person: "Alice", date: "2026-05-14" },
        {
          uid: "c2",
          kind: "request",
          person: "Bob",
          date: "2026-05-15",
          shiftType: "D",
          weight: 2,
        },
        { uid: "c3", kind: "off", person: "Bob", date: "2026-05-16", weight: 1 },
      ]);

      // All five Guided kinds + every durable field are reconstructed EXACTLY.
      expect(state.guidedRulePins).toEqual([
        {
          id: "g-req",
          constraintKind: "requirements",
          constraintId: "r1",
          category: "Coverage",
          quickFields: ["requiredNumPeople"],
          description: "cover D",
        },
        {
          id: "g-succ",
          constraintKind: "successions",
          constraintId: "s1",
          category: "Pattern",
          quickFields: ["pattern"],
        },
        {
          id: "g-cnt",
          constraintKind: "counts",
          constraintId: "n1",
          category: "Load",
          quickFields: ["expression"],
        },
        {
          id: "g-aff",
          constraintKind: "affinities",
          constraintId: "a1",
          category: "Pairing",
          quickFields: ["people1", "people2"],
        },
        {
          id: "g-cov",
          constraintKind: "coverings",
          constraintId: "v1",
          category: "Mentoring",
          quickFields: ["preceptors"],
        },
      ]);

      expect(state.exportLayout.formatting).toMatchObject([
        { type: "row", people: ["Alice"], backgroundColor: "#ff0000" },
      ]);

      // SEPARATELY: the strict projection of the same fixture matches the strict
      // model Python builds — proven through the real Python boundary, not the
      // shared TS mapping used for hydration above.
      const converted = convertWorkspaceForOptimize(FULL_AUTHORING);
      expect(converted.status).toBe("ok");
      if (converted.status !== "ok") return;
      const equiv = callOracle({
        op: "workspace_equiv",
        strict: serializeCanonicalDocument(converted.document),
        workspace: FULL_AUTHORING,
      });
      expect(equiv.ok).toBe(true);
      expect(equiv.equivalent).toBe(true);
    });

    it("a disabled record survives to authoring state but is stripped from strict projection", async () => {
      const state = await hydrateThroughStore(DISABLED_RECORD);

      expect(state.cardsByKind.requirements).toMatchObject([
        { uid: "r1", shiftType: "D", requiredNumPeople: 1 },
        { uid: "r2", disabled: true, shiftType: "E", requiredNumPeople: 2 },
      ]);
      expect(state.cardsByKind.requirements[0].disabled).not.toBe(true);
      expect(state.guidedRulePins).toEqual([
        {
          id: "g-req",
          constraintKind: "requirements",
          constraintId: "r1",
          category: "Coverage",
          quickFields: ["requiredNumPeople"],
        },
      ]);

      // Python accepts the backup and its strict model drops the disabled record.
      const canonical = callOracle({ op: "workspace_canonical", yaml: DISABLED_RECORD });
      expect(canonical.ok).toBe(true);
      const converted = convertWorkspaceForOptimize(DISABLED_RECORD);
      expect(converted.status).toBe("ok");
      if (converted.status !== "ok") return;
      const requirements = converted.document.preferences.filter(
        (p) => p.type === "shift type requirement",
      );
      expect(requirements).toHaveLength(1);
      expect(requirements[0]).toMatchObject({ shiftType: "D" });
    });

    it("an incomplete backup hydrates in TS while Python reports not_ready", async () => {
      const state = await hydrateThroughStore(INCOMPLETE_BACKUP);

      expect(state.rangeStart).toBe("");
      expect(state.rangeEnd).toBe("");
      expect(state.staff).toMatchObject([{ id: "Alice" }]);
      expect(state.cardsByKind.requirements).toMatchObject([{ uid: "r1", shiftType: "D" }]);

      expect(convertWorkspaceForOptimize(INCOMPLETE_BACKUP).status).toBe("not_ready");
      expect(callOracle({ op: "workspace_canonical", yaml: INCOMPLETE_BACKUP }).errorCode).toBe(
        "workspace_not_ready",
      );
    });
  },
);

// --- Direction 4: version scalar dispatch parity (bidirectional matrix) ---------
// A ready V1 body with the `workspaceVersion` scalar varied. Each form is dispatched
// by BOTH the TS classifier (`prepareScenarioLoad`, which routes on
// `classifyWorkspaceSource`) and the real Python `ruamel.yaml` loader
// (`workspace_canonical`), and the two must agree on V1-vs-not for every form.

const SCALAR_BODY = `apiVersion: alpha
dates:
  range:
    startDate: 2025-01-01
    endDate: 2025-01-01
people:
  items:
    - id: alice
shiftTypes:
  items:
    - id: day
preferences:
  - workspaceId: r1
    enabled: true
    type: at most one shift per day
`;

/** `true` when Python's real loader selects + accepts V1 for this document. */
function pythonSelectsV1(yaml: string): boolean {
  const res = callOracle({ op: "workspace_canonical", yaml });
  // A ready V1 doc canonicalizes (ok); a non-V1 version is the normative
  // unsupported-version rejection. Any other error would be a parity break.
  if (res.ok) return true;
  expect(res.errorCode).toBe("unsupported_workspace_version");
  return false;
}

/** `true` when the TS dispatcher routes this document to the Workspace V1 loader. */
function tsSelectsV1(yaml: string): boolean {
  const prepared = prepareScenarioLoad(yaml);
  // V1 selection yields a target (a ready V1 doc) or a structural issue; an
  // unsupported version yields the single `workspaceVersion` issue and no target.
  const unsupported =
    prepared.target === null &&
    prepared.issues.length === 1 &&
    prepared.issues[0].path === "workspaceVersion";
  return !unsupported;
}

const SCALAR_MATRIX: Array<{ label: string; scalar: string; v1: boolean }> = [
  { label: "plain 1", scalar: "1", v1: true },
  { label: "signed +1", scalar: "+1", v1: true },
  { label: "leading-zero 01", scalar: "01", v1: true },
  { label: "hex 0x1", scalar: "0x1", v1: true },
  { label: "octal 0o1", scalar: "0o1", v1: true },
  { label: "binary 0b1", scalar: "0b1", v1: true },
  { label: "explicit !!int 1", scalar: "!!int 1", v1: true },
  { label: "anchored &v 1", scalar: "&v 1", v1: true },
  { label: "trailing comment", scalar: "1  # v1", v1: true },
  { label: "float 1.0", scalar: "1.0", v1: false },
  { label: "single-quoted '1'", scalar: "'1'", v1: false },
  { label: 'double-quoted "1"', scalar: '"1"', v1: false },
  { label: "boolean true", scalar: "true", v1: false },
  { label: "null", scalar: "null", v1: false },
  { label: "integer 2", scalar: "2", v1: false },
  { label: "float 1.5", scalar: "1.5", v1: false },
];

describe.skipIf(!AVAILABLE)("workspace differential — version scalar dispatch parity", () => {
  for (const { label, scalar, v1 } of SCALAR_MATRIX) {
    it(`TS and Python agree that "${label}" ${v1 ? "selects" : "rejects"} V1`, () => {
      const yaml = `workspaceVersion: ${scalar}\n${SCALAR_BODY}`;
      expect(pythonSelectsV1(yaml)).toBe(v1);
      expect(tsSelectsV1(yaml)).toBe(v1);
    });
  }
});

describe.skipIf(!AVAILABLE)("workspace differential — rejection-category parity", () => {
  it("an incomplete backup is not_ready on both sides", () => {
    const fixture = `workspaceVersion: 1
apiVersion: alpha
dates:
  range:
    startDate: null
    endDate: null
people:
  items: []
shiftTypes:
  items: []
preferences: []
`;
    expect(convertWorkspaceForOptimize(fixture).status).toBe("not_ready");
    expect(callOracle({ op: "workspace_canonical", yaml: fixture }).errorCode).toBe(
      "workspace_not_ready",
    );
  });

  it("an unsupported version is rejected on both sides", () => {
    const fixture = "workspaceVersion: 2\napiVersion: alpha\n";
    expect(convertWorkspaceForOptimize(fixture).status).toBe("unsupported_version");
    expect(callOracle({ op: "workspace_canonical", yaml: fixture }).errorCode).toBe(
      "unsupported_workspace_version",
    );
  });

  it("an unknown top-level field is invalid on both sides", () => {
    const fixture = `workspaceVersion: 1
apiVersion: alpha
mysteryField: 1
dates:
  range:
    startDate: 2025-01-01
    endDate: 2025-01-01
people:
  items:
    - id: alice
shiftTypes:
  items:
    - id: day
preferences:
  - workspaceId: r1
    enabled: true
    type: at most one shift per day
`;
    expect(convertWorkspaceForOptimize(fixture).status).toBe("invalid");
    expect(callOracle({ op: "workspace_canonical", yaml: fixture }).errorCode).toBe(
      "invalid_scheduling_data",
    );
  });

  it("an unknown field inside a DISABLED preference is invalid on both sides", () => {
    // The strict body is validated BEFORE disabled filtering, so an unknown field
    // hiding in a disabled record cannot slip through on either side.
    const fixture = `workspaceVersion: 1
apiVersion: alpha
dates:
  range:
    startDate: 2025-01-01
    endDate: 2025-01-01
people:
  items:
    - id: alice
shiftTypes:
  items:
    - id: day
preferences:
  - workspaceId: r1
    enabled: false
    type: shift type requirement
    shiftType: day
    requiredNumPeople: 1
    mysteryField: 9
`;
    expect(convertWorkspaceForOptimize(fixture).status).toBe("invalid");
    expect(callOracle({ op: "workspace_canonical", yaml: fixture }).errorCode).toBe(
      "invalid_scheduling_data",
    );
  });

  it("a duplicate Guided source is not_ready on both sides and blocks hydration in TS", () => {
    const fixture = `workspaceVersion: 1
apiVersion: alpha
dates:
  range:
    startDate: 2025-01-01
    endDate: 2025-01-01
people:
  items:
    - id: alice
shiftTypes:
  items:
    - id: day
preferences:
  - workspaceId: r1
    enabled: true
    type: shift type requirement
    shiftType: day
    requiredNumPeople: 1
guidedRules:
  - id: g1
    constraintKind: requirements
    constraintId: r1
    category: Coverage
    quickFields: [requiredNumPeople]
  - id: g2
    constraintKind: requirements
    constraintId: r1
    category: Coverage
    quickFields: [requiredNumPeople]
`;
    expect(convertWorkspaceForOptimize(fixture).status).toBe("not_ready");
    expect(callOracle({ op: "workspace_canonical", yaml: fixture }).errorCode).toBe(
      "workspace_not_ready",
    );
    // The duplicate source also blocks the Load (hydration) path: it would corrupt
    // the durable one-pin-per-source invariant, so no import target is produced.
    expect(prepareScenarioLoad(fixture).target).toBeNull();
  });
});

// --- Workspace identity rejection parity (T17r review P1) -----------------------
// `workspaceId` is required on every V1 preference variant, and a duplicate id
// (across cards OR request cells) must be rejected before hydration. These prove
// TS and Python agree on the rejection CATEGORY, and that the production dispatcher
// (`prepareScenarioLoad`) never carries a malformed identity record into the store.

/** A ready V1 body missing the required `max-one-shift-per-day` singleton is added
 *  per fixture; this is just the shared valid head. */
const IDENTITY_HEAD = `workspaceVersion: 1
apiVersion: alpha
dates:
  range:
    startDate: 2025-01-01
    endDate: 2025-01-01
people:
  items:
    - id: alice
shiftTypes:
  items:
    - id: day`;

const IDENTITY_CASES: Array<{
  label: string;
  preferences: string;
  tsStatus: "invalid" | "not_ready";
  pyErrorCode: "invalid_scheduling_data" | "workspace_not_ready";
  /** The normative issue path both sides must report (category/path parity). */
  path: Array<string | number>;
}> = [
  {
    label: "a card preference missing its workspaceId",
    preferences: `
  - workspaceId: m1
    enabled: true
    type: at most one shift per day
  - enabled: true
    type: shift type requirement
    shiftType: day
    requiredNumPeople: 1`,
    tsStatus: "invalid",
    pyErrorCode: "invalid_scheduling_data",
    path: ["preferences", 1, "workspaceId"],
  },
  {
    label: "a request cell missing its workspaceId",
    preferences: `
  - workspaceId: m1
    enabled: true
    type: at most one shift per day
  - enabled: true
    type: shift request
    person: alice
    date: 2025-01-01
    shiftType: day`,
    tsStatus: "invalid",
    pyErrorCode: "invalid_scheduling_data",
    path: ["preferences", 1, "workspaceId"],
  },
  {
    label: "a card preference with an EMPTY workspaceId",
    preferences: `
  - workspaceId: ""
    enabled: true
    type: at most one shift per day
  - workspaceId: r1
    enabled: true
    type: shift type requirement
    shiftType: day
    requiredNumPeople: 1`,
    tsStatus: "not_ready",
    pyErrorCode: "workspace_not_ready",
    path: ["preferences", 0, "workspaceId"],
  },
  {
    label: "a request cell with an EMPTY workspaceId",
    preferences: `
  - workspaceId: m1
    enabled: true
    type: at most one shift per day
  - workspaceId: ""
    enabled: true
    type: shift request
    person: alice
    date: 2025-01-01
    shiftType: day`,
    tsStatus: "not_ready",
    pyErrorCode: "workspace_not_ready",
    path: ["preferences", 1, "workspaceId"],
  },
  {
    label: "a duplicate card workspaceId",
    preferences: `
  - workspaceId: dup
    enabled: true
    type: at most one shift per day
  - workspaceId: dup
    enabled: true
    type: shift type requirement
    shiftType: day
    requiredNumPeople: 1`,
    tsStatus: "not_ready",
    pyErrorCode: "workspace_not_ready",
    path: ["preferences", 1, "workspaceId"],
  },
  {
    label: "a duplicate request-cell workspaceId",
    preferences: `
  - workspaceId: m1
    enabled: true
    type: at most one shift per day
  - workspaceId: dup
    enabled: true
    type: shift request
    person: alice
    date: 2025-01-01
    shiftType: day
  - workspaceId: dup
    enabled: true
    type: shift request
    person: alice
    date: 2025-01-01
    shiftType: day`,
    tsStatus: "not_ready",
    pyErrorCode: "workspace_not_ready",
    path: ["preferences", 2, "workspaceId"],
  },
];

/** Whether an issue list carries an entry at exactly `path` (order-independent). */
function hasIssueAtPath(
  issues: Array<{ path: Array<string | number> }> | undefined,
  path: Array<string | number>,
): boolean {
  const target = JSON.stringify(path);
  return (issues ?? []).some((issue) => JSON.stringify(issue.path) === target);
}

describe.skipIf(!AVAILABLE)("workspace differential — Workspace identity rejection parity", () => {
  for (const { label, preferences, tsStatus, pyErrorCode, path } of IDENTITY_CASES) {
    it(`${label} is rejected in the same category AND at the same path by both sides, never hydrating`, () => {
      const fixture = `${IDENTITY_HEAD}\npreferences:${preferences}\n`;
      // Optimize path: TS and Python agree on the normative rejection category…
      const converted = convertWorkspaceForOptimize(fixture);
      expect(converted.status).toBe(tsStatus);
      const oracle = callOracle({ op: "workspace_canonical", yaml: fixture });
      expect(oracle.errorCode).toBe(pyErrorCode);
      // …and on the exact issue path.
      const tsIssues = "issues" in converted ? converted.issues : undefined;
      expect(hasIssueAtPath(tsIssues, path)).toBe(true);
      expect(hasIssueAtPath(oracle.issues, path)).toBe(true);
      // Load path: the production dispatcher rejects before hydration — no import
      // target is produced, so `loadScenario` is never reached and no replacement
      // identity (empty-string → minted UUID) is created.
      expect(prepareScenarioLoad(fixture).target).toBeNull();
    });
  }
});
