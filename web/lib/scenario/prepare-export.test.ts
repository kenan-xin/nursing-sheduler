import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { prepareAnonymizedExport, prepareExport } from "./prepare-export";
import { makeValidUiState } from "./test-fixtures";
import type { PersonRef, ScenarioUiState } from "./types";

const APP_VERSION_ENV = "NEXT_PUBLIC_APP_VERSION";
/** A deterministic RNG (Fisher–Yates with `() => 0` is fully reproducible). */
const rng0 = () => 0;

afterEach(() => {
  vi.unstubAllEnvs();
});

/** A state whose contracted-hours card has incomplete coefficient coverage
 *  (producer schema rejects it — see producer.test.ts). */
function makeInvalidContractedHoursState(): ScenarioUiState {
  const state = makeValidUiState();
  state.cardsByKind.counts = [
    {
      uid: "h1",
      person: "ALL",
      countDates: "ALL",
      countShiftTypes: ["D", "E"],
      countShiftTypeCoefficients: [["D", 1]], // missing E — incomplete
      expression: "x = T",
      target: 5,
      weight: Infinity,
      tag: "contracted_hours",
      policy: "exact",
    },
  ];
  return state;
}

describe("prepareExport (plain export gate)", () => {
  it("returns { ok: true, yaml } for a valid state, appVersion stamped last", () => {
    vi.stubEnv(APP_VERSION_ENV, "9.9.9");
    const result = prepareExport(makeValidUiState());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const parsed = parse(result.yaml) as Record<string, unknown>;
    expect(parsed.appVersion).toBe("9.9.9");
    expect(Object.keys(parsed).at(-1)).toBe("appVersion");
  });

  it("returns { ok: false, issues } for an invalid contracted-hours draft, without throwing", () => {
    const state = makeInvalidContractedHoursState();
    let result: ReturnType<typeof prepareExport> | undefined;
    expect(() => {
      result = prepareExport(state);
    }).not.toThrow();
    expect(result?.ok).toBe(false);
    if (result?.ok !== false) return;
    expect(result.issues.some((i) => /coverage is incomplete/.test(i.message))).toBe(true);
  });
});

describe("prepareAnonymizedExport — independent people/group toggles", () => {
  it("people:true, groups:false rewrites person ids only, leaves group ids, and never mutates live state", () => {
    vi.stubEnv(APP_VERSION_ENV, "9.9.9");
    const state = makeValidUiState();
    const snapshot = structuredClone(state);

    const result = prepareAnonymizedExport(state, { people: true, groups: false, scatter: false });

    expect(state).toEqual(snapshot);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const parsed = parse(result.yaml) as Record<string, unknown>;
    expect(parsed.appVersion).toBe("9.9.9");
    expect(Object.keys(parsed).at(-1)).toBe("appVersion");

    const people = parsed.people as { items: { id: string }[]; groups: { id: string }[] };
    expect(people.items.map((p) => p.id)).toEqual(["P1", "P2"]);
    // Group id itself is left as authored — only the people-item domain toggled.
    expect(people.groups[0].id).toBe("Seniors");
  });

  it("people:true, groups:true rewrites both domains", () => {
    const state = makeValidUiState();
    const result = prepareAnonymizedExport(state, { people: true, groups: true, scatter: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const parsed = parse(result.yaml) as Record<string, unknown>;
    const people = parsed.people as { items: { id: string }[]; groups: { id: string }[] };
    expect(people.items.map((p) => p.id)).toEqual(["P1", "P2"]);
    expect(people.groups[0].id).toBe("G1");
  });
});

describe("prepareAnonymizedExport — scatter (FR-SL-37)", () => {
  it("succeeds and stays valid with scatter on and an injected rng", () => {
    const state = makeValidUiState();
    const result = prepareAnonymizedExport(state, {
      people: true,
      groups: false,
      scatter: true,
      rng: rng0,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const parsed = parse(result.yaml) as Record<string, unknown>;
    expect(Object.keys(parsed).at(-1)).toBe("appVersion");
  });

  it("returns { ok: false, issues } when scatter rejects a multi-person shift request (V16)", () => {
    const state = makeValidUiState();
    state.reqData.push({
      uid: "multi",
      kind: "request",
      person: ["Alice", "Bob"] as unknown as PersonRef,
      date: "2026-05-17",
      shiftType: "D",
      weight: 1,
    });

    const result = prepareAnonymizedExport(state, {
      people: true,
      groups: false,
      scatter: true,
      rng: rng0,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(
      result.issues.some((i) =>
        /Cannot scatter shift requests with multiple people or multiple shift types/.test(
          i.message,
        ),
      ),
    ).toBe(true);
  });
});

describe("prepareAnonymizedExport — invalid source blocks before any transform", () => {
  it("returns { ok: false, issues } for an invalid contracted-hours draft", () => {
    const state = makeInvalidContractedHoursState();
    const result = prepareAnonymizedExport(state, { people: true, groups: true, scatter: true });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => /coverage is incomplete/.test(i.message))).toBe(true);
  });
});
