// lib/proposal MUST NOT REACH REACT. The durable repository and the diagnostic
// orchestrator import it (see the header of `operations.ts`), so a React import
// anywhere in these graphs drags the component tree into the scenario path. Each
// mocked specifier throws on load, so any module that reaches React fails its import
// here, whether it is a direct or a transitive import.

import { describe, expect, it, vi } from "vitest";

vi.mock("react", () => {
  throw new Error("React was imported");
});
vi.mock("react/jsx-runtime", () => {
  throw new Error("React was imported");
});
vi.mock("react/jsx-dev-runtime", () => {
  throw new Error("React was imported");
});

describe("the assistant's host layer reaches no React", () => {
  it.each([
    ["operations", () => import("./operations")],
    ["diff", () => import("./diff")],
    ["commands", () => import("./commands")],
    ["successions model", () => import("@/components/successions/successions-model")],
    ["counts model", () => import("@/components/counts/counts-model")],
    ["requirements model", () => import("@/components/requirements/requirements-model")],
    ["requirement patch", () => import("@/components/requirements/requirement-patch")],
  ])("%s", async (_name, load) => {
    await expect(load()).resolves.toBeDefined();
  });
});
