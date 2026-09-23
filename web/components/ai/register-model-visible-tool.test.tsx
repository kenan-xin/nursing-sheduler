// @vitest-environment jsdom
//
// THE REGISTRATION-ATTEMPT INVARIANT.
//
// CopilotKit resolves a tool by `{ toolName, agentId }` and its `addTool` discards a second
// registration for a live pair BEFORE it reaches `core.tools`. So the collision that
// matters -- one module silently replacing another module's handler -- is invisible to any
// proof that reads the final registry. A reviewer added a second `get_schedule_overview`
// to the production tree and all four mounted-surface assertions stayed green.
//
// The wrapper counts the ATTEMPT instead, which is the only place every model-visible
// registration passes through. This suite is that invariant's own proof: it registers the
// same identity twice through the shipped wrapper and requires the mount to fail.

import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { z } from "zod";
import { CopilotKitProvider } from "@copilotkit/react-core/v2";

import {
  useModelVisibleTool,
  useParameterlessModelVisibleTool,
} from "./register-model-visible-tool";

const AGENT_ID = "scheduler:thread-1";
const schema = z.object({ value: z.string() });

function Mounted({ children }: { children: React.ReactNode }) {
  return <CopilotKitProvider>{children}</CopilotKitProvider>;
}

function OneTool() {
  useModelVisibleTool(
    {
      name: "probe_tool",
      agentId: AGENT_ID,
      description: "probe",
      parameters: schema,
      handler: async () => "ok",
    },
    [AGENT_ID],
  );
  return null;
}

function DuplicateTool() {
  // The SAME identity, registered twice, exactly as two modules would.
  useModelVisibleTool(
    {
      name: "probe_tool",
      agentId: AGENT_ID,
      description: "probe",
      parameters: schema,
      handler: async () => "first",
    },
    [AGENT_ID],
  );
  useModelVisibleTool(
    {
      name: "probe_tool",
      agentId: AGENT_ID,
      description: "shadow",
      parameters: schema,
      handler: async () => "second",
    },
    [AGENT_ID],
  );
  return null;
}

function DuplicateParameterless() {
  useParameterlessModelVisibleTool(
    { name: "probe_overview", agentId: AGENT_ID, description: "a", handler: async () => "first" },
    [AGENT_ID],
  );
  useParameterlessModelVisibleTool(
    { name: "probe_overview", agentId: AGENT_ID, description: "b", handler: async () => "second" },
    [AGENT_ID],
  );
  return null;
}

function DifferentNames() {
  useModelVisibleTool(
    {
      name: "probe_a",
      agentId: AGENT_ID,
      description: "a",
      parameters: schema,
      handler: async () => "a",
    },
    [AGENT_ID],
  );
  useModelVisibleTool(
    {
      name: "probe_b",
      agentId: AGENT_ID,
      description: "b",
      parameters: schema,
      handler: async () => "b",
    },
    [AGENT_ID],
  );
  return null;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// NO GLOBAL RESET SEAM, deliberately. The ledger is keyed by the provider core, so each
// `render` below gets a fresh provider and therefore a fresh ledger. A module-global map
// needed a reset export -- and that export was itself the tell that tests and real
// sessions were sharing one mutable namespace.

describe("the canonical wrapper refuses a duplicate identity", () => {
  it("is non-vacuous: one registration mounts cleanly", () => {
    expect(() =>
      render(
        <Mounted>
          <OneTool />
        </Mounted>,
      ),
    ).not.toThrow();
  });

  it("fails fast when the same (agentId, name) is registered twice", () => {
    // React surfaces a throw from an effect; the message names the exact identity so the
    // failure points at the collision rather than at whichever module happened to mount
    // second.
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() =>
      render(
        <Mounted>
          <DuplicateTool />
        </Mounted>,
      ),
    ).toThrow(/Duplicate model-visible tool registration for scheduler:thread-1::probe_tool/);
  });

  it("fails fast for a duplicate parameterless tool too", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() =>
      render(
        <Mounted>
          <DuplicateParameterless />
        </Mounted>,
      ),
    ).toThrow(/Duplicate model-visible tool registration for scheduler:thread-1::probe_overview/);
  });

  it("is not over-eager: two different names on one agent are fine", () => {
    expect(() =>
      render(
        <Mounted>
          <DifferentNames />
        </Mounted>,
      ),
    ).not.toThrow();
  });

  it("is not over-eager: the SAME identity in two independent providers coexists", () => {
    // THE FALSE POSITIVE A MODULE-GLOBAL LEDGER PRODUCED. A collision is core-local --
    // two `CopilotKitProvider` roots own two independent registries, and CopilotKit would
    // not deduplicate across them -- so rejecting the second root reported a conflict that
    // does not exist. The previous "not over-eager" control used two different NAMES in
    // one provider, which is why it never caught this.
    expect(() =>
      render(
        <>
          <Mounted>
            <OneTool />
          </Mounted>
          <Mounted>
            <OneTool />
          </Mounted>
        </>,
      ),
    ).not.toThrow();
  });

  it("survives StrictMode effect replay", () => {
    // StrictMode mounts, unmounts and remounts effects. The claim is released on cleanup,
    // so the replay nets to zero rather than looking like a duplicate.
    expect(() =>
      render(
        <StrictMode>
          <Mounted>
            <OneTool />
          </Mounted>
        </StrictMode>,
      ),
    ).not.toThrow();
  });

  it("releases an identity on unmount, so a remount is not a collision", () => {
    render(
      <Mounted>
        <OneTool />
      </Mounted>,
    );
    cleanup();
    expect(() =>
      render(
        <Mounted>
          <OneTool />
        </Mounted>,
      ),
    ).not.toThrow();
  });
});
