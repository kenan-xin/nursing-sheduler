// Pure TypeScript Workspace V1 contract tests (T17r). These bind the frontend
// half of the shared boundary WITHOUT Python: source selection, unknown-field
// rejection, incomplete-but-loadable backups, readiness issues, disabled-record
// filtering, and — the load-bearing invariant — that a Workspace round-trip
// projects to the exact same strict bytes as the direct strict producer. The
// cross-language equivalence against the pinned T19 backend lives in
// `./differential/workspace-differential.test.ts`.

import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { serializeCanonicalDocument, serializeScenario } from "./serialize";
import {
  buildWorkspaceDocument,
  checkWorkspaceReadiness,
  classifyWorkspaceSource,
  convertWorkspaceForOptimize,
  parseWorkspaceYaml,
  serializeWorkspace,
  workspaceRootSchema,
  WORKSPACE_VERSION,
} from "./workspace";
import { prepareScenarioLoad } from "./prepare-scenario-load";
import { makeValidUiState } from "./test-fixtures";
import { PREFERENCE_TYPE, type GuidedRulePin } from "./types";

// A minimal, optimize-ready Workspace document mirroring the T19 Python fixture,
// used by the readiness/error cases that need a valid baseline to perturb.
const READY_WORKSPACE = `workspaceVersion: 1
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
`;

function convert(yaml: string) {
  return convertWorkspaceForOptimize(yaml);
}

describe("workspace source selection", () => {
  it("selects legacy only when workspaceVersion is absent", () => {
    expect(classifyWorkspaceSource("apiVersion: alpha\n")).toEqual({ kind: "legacy" });
  });

  it("selects V1 for a plain integer scalar exactly equal to 1", () => {
    expect(classifyWorkspaceSource("workspaceVersion: 1\napiVersion: alpha\n")).toEqual({
      kind: "v1",
    });
  });

  // The complete scalar acceptance matrix, frozen bidirectionally with the Python
  // authority (core/tests/test_server_scheduling_input.py): every form the real
  // ruamel safe loader resolves to integer 1 selects V1, including `01`, `0o1`,
  // radices, `+1`, a comment, an explicit `!!int`, and anchors/aliases.
  it.each([
    ["a plain 1", "workspaceVersion: 1\napiVersion: alpha\n"],
    ["a signed +1", "workspaceVersion: +1\napiVersion: alpha\n"],
    ["a leading-zero octal 01", "workspaceVersion: 01\napiVersion: alpha\n"],
    ["a 0o octal 0o1", "workspaceVersion: 0o1\napiVersion: alpha\n"],
    ["a hex 0x1", "workspaceVersion: 0x1\napiVersion: alpha\n"],
    ["a binary 0b1", "workspaceVersion: 0b1\napiVersion: alpha\n"],
    ["a commented 1", "workspaceVersion: 1  # v\napiVersion: alpha\n"],
    ["an explicit !!int 1", "workspaceVersion: !!int 1\napiVersion: alpha\n"],
    ["an anchored 1", "workspaceVersion: &v 1\nx: *v\napiVersion: alpha\n"],
    ["an aliased 1", "anchor: &v 1\nworkspaceVersion: *v\napiVersion: alpha\n"],
  ])("selects V1 for %s (matches the Python ruamel loader)", (_label, doc) => {
    expect(classifyWorkspaceSource(doc).kind).toBe("v1");
  });

  // Dispatch is not enough: a ready V1 document must actually CONVERT, not be
  // rejected downstream. The plain YAML-1.2 structural parse leaves some accepted
  // scalars (notably a binary `0b1`) as a non-`1` value; the loader normalizes the
  // already-dispatched version so `z.literal(1)` cannot reject a valid V1 file
  // (T17r review P1-5 — differential parity with the ruamel loader).
  it.each([
    ["a leading-zero octal 01", "workspaceVersion: 01"],
    ["a binary 0b1", "workspaceVersion: 0b1"],
    ["an explicit !!int 1", "workspaceVersion: !!int 1"],
  ])("converts a ready V1 backup whose version is %s", (_label, versionLine) => {
    const yaml = READY_WORKSPACE.replace("workspaceVersion: 1", versionLine);
    expect(convert(yaml).status).toBe("ok");
  });

  // Every form the Python loader does NOT resolve to integer 1 is unsupported: a
  // float, quoted strings, booleans, null, an explicit non-int tag, the
  // underscore-separated `1_0` (= 10), and an unsupported integer.
  it.each([
    ["the integer 2", "2"],
    ["a float 1.0", "1.0"],
    ["a double-quoted string", '"1"'],
    ["a single-quoted string", "'1'"],
    ["a boolean true", "true"],
    ["a boolean false", "false"],
    ["null", "null"],
    ["an underscored 1_0", "1_0"],
    ["an unsupported octal 0o2", "0o2"],
    ["an explicit !!str 1", "!!str 1"],
  ])(
    "rejects %s as an unsupported version (matches the Python ruamel loader)",
    (_label, scalar) => {
      expect(classifyWorkspaceSource(`workspaceVersion: ${scalar}\napiVersion: alpha\n`).kind).toBe(
        "unsupported",
      );
    },
  );

  it("routes a legacy document to the legacy path", () => {
    const result = convert("apiVersion: alpha\ndates:\n  range:\n    startDate: 2025-01-01\n");
    expect(result.status).toBe("legacy");
  });

  it("reports an unsupported version through the structured envelope", () => {
    const result = convert("workspaceVersion: 2\napiVersion: alpha\n");
    expect(result.status).toBe("unsupported_version");
    if (result.status !== "unsupported_version") return;
    expect(result.value).toBe(2);
    expect(result.issues).toEqual([
      {
        path: ["workspaceVersion"],
        code: "unsupported_value",
        message: "Unsupported workspaceVersion: 2.",
      },
    ]);
  });
});

describe("workspace structural validation", () => {
  it("rejects an unknown top-level field for a known version", () => {
    const result = convert(
      "workspaceVersion: 1\napiVersion: alpha\nmysteryField: 1\n" +
        READY_WORKSPACE.split("\n").slice(2).join("\n"),
    );
    expect(result.status).toBe("invalid");
    if (result.status !== "invalid") return;
    expect(result.issues).toContainEqual(
      expect.objectContaining({ path: ["mysteryField"], code: "unknown_field" }),
    );
  });

  it("rejects an unknown field inside a Guided rule", () => {
    const yaml = READY_WORKSPACE.replace(
      "quickFields: [requiredNumPeople]",
      "quickFields: [requiredNumPeople]\n    mystery: 1",
    );
    const result = convert(yaml);
    expect(result.status).toBe("invalid");
    if (result.status !== "invalid") return;
    expect(result.issues).toContainEqual(
      expect.objectContaining({ path: ["guidedRules", 0, "mystery"], code: "unknown_field" }),
    );
  });

  it("rejects a non-boolean enabled flag (StrictBool parity)", () => {
    const yaml = READY_WORKSPACE.replace(
      "enabled: true\n    type: at most one shift per day",
      "enabled: 1\n    type: at most one shift per day",
    );
    const result = convert(yaml);
    expect(result.status).toBe("invalid");
  });
});

describe("workspace optimize readiness", () => {
  const INCOMPLETE = `workspaceVersion: 1
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

  it("keeps an incomplete backup structurally loadable", () => {
    // DL12 D2: an incomplete backup parses (loads) even though it is not
    // optimize-ready — the structural schema accepts null dates and empty items.
    expect(workspaceRootSchema.safeParse(parseWorkspaceYaml(INCOMPLETE)).success).toBe(true);
  });

  it("rejects an incomplete backup at optimize readiness", () => {
    const result = convert(INCOMPLETE);
    expect(result.status).toBe("not_ready");
    if (result.status !== "not_ready") return;
    const flagged = new Set(result.issues.map((issue) => JSON.stringify([issue.path, issue.code])));
    expect(flagged).toContain(
      JSON.stringify([["dates", "range", "startDate"], "workspace_incomplete"]),
    );
    expect(flagged).toContain(
      JSON.stringify([["dates", "range", "endDate"], "workspace_incomplete"]),
    );
    expect(flagged).toContain(JSON.stringify([["people", "items"], "workspace_incomplete"]));
    expect(flagged).toContain(JSON.stringify([["shiftTypes", "items"], "workspace_incomplete"]));
  });

  it("flags a duplicate preference workspaceId", () => {
    const yaml = READY_WORKSPACE.replace("workspaceId: r2", "workspaceId: r1");
    const issues = checkWorkspaceReadiness(workspaceRootSchema.parse(parseWorkspaceYaml(yaml)));
    expect(issues).toContainEqual(expect.objectContaining({ code: "duplicate_workspace_id" }));
  });

  it("rejects a preference missing its workspaceId as structurally invalid (matches Python)", () => {
    // `workspaceId` is required on every V1 variant, so a missing one is a
    // structural schema violation (Python: invalid_scheduling_data / missing_field),
    // not a readiness issue (T17r review P1).
    const yaml = READY_WORKSPACE.replace(
      "  - workspaceId: r2\n    enabled: true\n    type: shift type requirement",
      "  - enabled: true\n    type: shift type requirement",
    );
    const result = convert(yaml);
    expect(result.status).toBe("invalid");
    if (result.status !== "invalid") return;
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        path: ["preferences", 1, "workspaceId"],
        code: "missing_field",
      }),
    );
  });

  it("flags an unresolved Guided reference", () => {
    const yaml = READY_WORKSPACE.replace("constraintId: r2", "constraintId: does-not-exist");
    const result = convert(yaml);
    expect(result.status).toBe("not_ready");
    if (result.status !== "not_ready") return;
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        path: ["guidedRules", 0, "constraintId"],
        code: "unresolved_workspace_reference",
      }),
    );
  });

  it("flags a Guided rule whose constraintKind does not match the pinned preference", () => {
    const yaml = READY_WORKSPACE.replace("constraintKind: requirements", "constraintKind: counts");
    const result = convert(yaml);
    expect(result.status).toBe("not_ready");
    if (result.status !== "not_ready") return;
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        path: ["guidedRules", 0, "constraintKind"],
        code: "unresolved_workspace_reference",
      }),
    );
  });

  it("orders issues deterministically", () => {
    const result = convert(INCOMPLETE);
    if (result.status !== "not_ready") throw new Error("expected not_ready");
    const encoded = result.issues.map((issue) => [
      JSON.stringify(issue.path),
      issue.code,
      issue.message,
    ]);
    const sorted = [...encoded].sort((a, b) =>
      a[0] < b[0]
        ? -1
        : a[0] > b[0]
          ? 1
          : a[1] < b[1]
            ? -1
            : a[1] > b[1]
              ? 1
              : a[2] < b[2]
                ? -1
                : a[2] > b[2]
                  ? 1
                  : 0,
    );
    expect(encoded).toEqual(sorted);
  });
});

describe("workspace strict projection", () => {
  it("converts a ready workspace and strips disabled records + authoring metadata", () => {
    const result = convert(READY_WORKSPACE);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    // The disabled r3 shift request never reaches the strict document.
    const requests = result.document.preferences.filter(
      (p) => p.type === PREFERENCE_TYPE.shiftRequest,
    );
    expect(requests).toHaveLength(0);
    // Workspace-only identity/guided metadata is gone.
    const serialized = serializeCanonicalDocument(result.document);
    expect(serialized).not.toMatch(/workspaceId|guidedRules|enabled|workspaceVersion/);
  });

  it("projects a Workspace round-trip to the exact strict producer bytes", () => {
    const state = makeValidUiState();
    const result = convert(serializeWorkspace(state));
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    // Key order is not semantic (Zod re-emits validated keys in schema order);
    // compare the documents order-independently. Byte/semantic equivalence through
    // the real Python backend is proven by the differential gate.
    expect(parse(serializeCanonicalDocument(result.document))).toEqual(
      parse(serializeScenario(state)),
    );
  });

  it("filters a disabled card and still matches the strict producer projection", () => {
    const state = makeValidUiState();
    state.cardsByKind.requirements[0].disabled = true;
    const yaml = serializeWorkspace(state);
    expect(yaml).toMatch(/enabled: false/);
    const result = convert(yaml);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    // Both the Workspace projection and the strict producer drop the disabled card.
    // Key order is not semantic (Zod re-emits validated keys in schema order);
    // compare the documents order-independently. Byte/semantic equivalence through
    // the real Python backend is proven by the differential gate.
    expect(parse(serializeCanonicalDocument(result.document))).toEqual(
      parse(serializeScenario(state)),
    );
    expect(
      result.document.preferences.some((p) => p.type === PREFERENCE_TYPE.shiftTypeRequirement),
    ).toBe(false);
  });
});

describe("workspace full-authoring round trip (hydration, separate from strict projection)", () => {
  it("restores disabled records, complete Guided pins, stable request ids, and incomplete dates", () => {
    const pin: GuidedRulePin = {
      id: "pin-1",
      constraintKind: "requirements",
      constraintId: "req-1",
      category: "Coverage",
      quickFields: ["requiredNumPeople"],
      description: "Cover the day shift",
    };
    const state = makeValidUiState();
    // A DISABLED requirement carrying a known uid, plus a Guided pin over it.
    state.cardsByKind.requirements = [
      { uid: "req-1", shiftType: "D", requiredNumPeople: 1, weight: -1, disabled: true },
    ];
    state.guidedRulePins = [pin];
    state.reqData = [
      {
        uid: "cell-1",
        kind: "request",
        person: "Alice",
        date: "2026-05-15",
        shiftType: "D",
        weight: 2,
      },
    ];

    // Round-trip through the REAL frontend load dispatcher (Workspace branch).
    const loaded = prepareScenarioLoad(serializeWorkspace(state));
    expect(loaded.issues).toEqual([]);
    const target = loaded.target;
    if (!target) throw new Error("expected a hydrated target");

    // Every durable Guided pin field survives — not just id/description.
    expect(target.guidedRulePins).toEqual([pin]);
    // The disabled record is preserved (not filtered) and keeps its workspaceId as uid.
    expect(target.cardsByKind.requirements[0]).toMatchObject({ uid: "req-1", disabled: true });
    // Stable request-cell identity is preserved from the file, not re-derived.
    expect(target.reqData.find((cell) => cell.person === "Alice")?.uid).toBe("cell-1");

    // An incomplete backup still loads, with null dates restored as empty strings.
    const incomplete = makeValidUiState();
    incomplete.rangeStart = "";
    incomplete.rangeEnd = "";
    const incompleteLoaded = prepareScenarioLoad(serializeWorkspace(incomplete));
    expect(incompleteLoaded.issues).toEqual([]);
    expect(incompleteLoaded.target?.rangeStart).toBe("");
    expect(incompleteLoaded.target?.rangeEnd).toBe("");
  });

  it("routes a legacy (no workspaceVersion) file through the unchanged legacy path", () => {
    const legacy = prepareScenarioLoad(serializeScenario(makeValidUiState()));
    expect(legacy.issues).toEqual([]);
    expect(legacy.target?.guidedRulePins).toEqual([]);
  });
});

describe("workspace load — durable identity rejection (before hydration)", () => {
  // A missing or duplicate preference workspaceId must block the Load (no import
  // target) rather than reach `loadScenario` and mint/collide on a durable id
  // (T17r review P1). Legacy imports keep their own UUID allocation and are
  // exercised by the legacy-path test above.
  it.each([
    [
      "a card preference missing its workspaceId",
      READY_WORKSPACE.replace(
        "  - workspaceId: r2\n    enabled: true\n    type: shift type requirement",
        "  - enabled: true\n    type: shift type requirement",
      ),
    ],
    [
      "a request cell missing its workspaceId",
      READY_WORKSPACE.replace(
        "  - workspaceId: r3\n    enabled: false\n    type: shift request",
        "  - enabled: false\n    type: shift request",
      ),
    ],
    ["a duplicate card workspaceId", READY_WORKSPACE.replace("workspaceId: r2", "workspaceId: r1")],
    [
      "a duplicate request-cell workspaceId",
      READY_WORKSPACE.replace("workspaceId: r3", "workspaceId: r1"),
    ],
    // An EMPTY id passes the `z.string()` schema but is a falsy (missing) durable
    // identity — it must block before `loadScenario`, or `ensureCellUid` would mint
    // a UUID for the request cell and lose round-trip fidelity (T17r review P1).
    [
      'a card preference with an empty ("") workspaceId',
      READY_WORKSPACE.replace("workspaceId: r2", 'workspaceId: ""'),
    ],
    [
      'a request cell with an empty ("") workspaceId',
      READY_WORKSPACE.replace("workspaceId: r3", 'workspaceId: ""'),
    ],
  ])("blocks %s before hydration", (_label, yaml) => {
    const result = prepareScenarioLoad(yaml);
    expect(result.target).toBeNull();
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues.some((issue) => issue.path.includes("workspaceId"))).toBe(true);
  });

  it("classifies an empty workspaceId as not_ready (workspace_incomplete), matching Python's falsy rule", () => {
    // An empty id is a readiness issue on BOTH sides (Python: workspace_not_ready /
    // workspace_incomplete), NOT a structural `invalid` — so the differential
    // category parity holds. No trimming: only the exact "" is falsy.
    const yaml = READY_WORKSPACE.replace("workspaceId: r2", 'workspaceId: ""');
    const result = convert(yaml);
    expect(result.status).toBe("not_ready");
    if (result.status !== "not_ready") return;
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        path: ["preferences", 1, "workspaceId"],
        code: "workspace_incomplete",
      }),
    );
  });
});

describe("workspace serialization wire form", () => {
  it("emits workspaceVersion first and appVersion last, with explicit enabled", () => {
    const document = buildWorkspaceDocument(makeValidUiState());
    const keys = Object.keys(document);
    expect(keys[0]).toBe("workspaceVersion");
    expect(keys[keys.length - 1]).toBe("appVersion");
    expect(document.workspaceVersion).toBe(WORKSPACE_VERSION);
    expect(
      document.preferences.every((preference) => typeof preference.enabled === "boolean"),
    ).toBe(true);
  });

  it("preserves Unicode, emits infinite weight as .inf, and uses no anchors/aliases", () => {
    const state = makeValidUiState();
    state.meta.description = "Ward 7B — 病棟";
    // Two people groups sharing the same member list exercise duplicate-value output.
    state.staffGroups = [
      { id: "g1", members: ["Alice", "Bob"] },
      { id: "g2", members: ["Alice", "Bob"] },
    ];
    const yaml = serializeWorkspace(state);
    const lines = yaml.replace(/\n+$/, "").split("\n");
    expect(lines[0]).toBe("workspaceVersion: 1");
    expect(lines[lines.length - 1]).toMatch(/^appVersion:/);
    expect(yaml).toContain("病棟");
    // The leave matrix cell serializes with the hard LEAVE pin weight.
    expect(yaml).toContain(".inf");
    expect(yaml.endsWith("\n")).toBe(true);
    expect(yaml).not.toContain("\r");
    // No YAML anchors (`&name`) or aliases (`*name`) — repeated values by value.
    expect(yaml).not.toMatch(/[&*][A-Za-z0-9]/);
  });
});
