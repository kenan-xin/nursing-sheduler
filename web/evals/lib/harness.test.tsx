// @vitest-environment jsdom
// The harness wiring, proven with a scripted transport: no key, no network. The live
// agent path is proven by the smoke run (plan Task 10).
import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { AbstractAgent, type BaseEvent, type RunAgentInput } from "@ag-ui/client";
import { Observable } from "rxjs";
import type { EvalCase } from "./case";
import { Ledger } from "./budget";
import { runTrial } from "./harness";

const seams = vi.hoisted(() => ({ agent: null as unknown, pushes: [] as string[] }));
vi.mock("next/navigation", () => ({
  usePathname: () => window.location.pathname,
  useRouter: () => ({
    push: (path: string) => {
      seams.pushes.push(path);
      window.history.replaceState({}, "", path);
    },
    replace: () => undefined,
    prefetch: () => undefined,
  }),
}));
vi.mock("@copilotkit/react-core/v2", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useAgent: () => ({ agent: seams.agent, isReady: true }),
}));

/** Hop 1 calls `toolName` with `args` (when set); the last hop answers `text`. `hang` never finishes. */
class ScriptedAgent extends AbstractAgent {
  private hop = 0;
  constructor(readonly script: { toolName?: string; args?: string; text: string; hang?: boolean }) {
    super({ agentId: "eval", threadId: "t" });
  }
  run(input: RunAgentInput): Observable<BaseEvent> {
    const nth = (this.hop += 1);
    const { toolName, args, text, hang } = this.script;
    return new Observable<BaseEvent>((sub) => {
      const emit = (e: Record<string, unknown>) => sub.next(e as unknown as BaseEvent);
      emit({ type: "RUN_STARTED", threadId: input.threadId, runId: input.runId });
      if (hang) return;
      if (toolName && nth === 1) {
        const id = `${input.runId}-call`;
        emit({
          type: "TOOL_CALL_START",
          parentMessageId: `m-${id}`,
          toolCallId: id,
          toolCallName: toolName,
        });
        emit({ type: "TOOL_CALL_ARGS", toolCallId: id, delta: args ?? "{}" });
        emit({ type: "TOOL_CALL_END", toolCallId: id });
      } else {
        const id = `${input.runId}-a`;
        emit({ type: "TEXT_MESSAGE_START", messageId: id, role: "assistant" });
        emit({ type: "TEXT_MESSAGE_CONTENT", messageId: id, delta: text });
        emit({ type: "TEXT_MESSAGE_END", messageId: id });
      }
      emit({ type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId });
      sub.complete();
    });
  }
  override clone(): ScriptedAgent {
    const copy = new ScriptedAgent(this.script);
    copy.threadId = this.threadId;
    copy.agentId = this.agentId;
    copy.setMessages([...this.messages]);
    return copy;
  }
}

const base: EvalCase = {
  id: "harness",
  tags: [],
  description: "",
  today: "2026-09-24",
  route: "/shift-requests",
  seed: { fixture: "understaffedNight" },
  user: { turns: ["Shorten the roster to the first three days."], onPreview: "apply" },
  limits: { timeoutMs: 20_000 },
  expect: {},
};

const input = (evalCase: EvalCase, script: ConstructorParameters<typeof ScriptedAgent>[0]) => ({
  evalCase,
  trial: 0,
  seams,
  ledger: new Ledger(1),
  apiKey: "sk-or-v1-TEST-SENTINEL-DO-NOT-LEAK-0000000000",
  model: "anthropic/claude-sonnet-4.5",
  userModel: null,
  agentFactory: () => new ScriptedAgent(script),
});

describe("runTrial", () => {
  it("seeds the ward, sends the turn and records the reply", async () => {
    const r = await runTrial(
      input({ ...base, user: { turns: ["hello"] } }, { text: "Hi, how can I help?" }),
    );
    expect(r.error).toBeNull();
    expect(r.seed.staff.map((p) => p.id)).toEqual(["ana", "ben", "cara"]);
    expect(r.transcript.at(-1)).toMatchObject({ role: "assistant", text: "Hi, how can I help?" });
  });

  it("captures a prepared Preview, applies it, records the navigation and the new state", async () => {
    const args = JSON.stringify({
      summary: "Shorten the roster.",
      operations: [
        {
          type: "set_roster_range",
          start: "2026-11-01",
          end: "2026-11-03",
          importPublicHolidays: false,
        },
      ],
    });
    const r = await runTrial(
      input(base, { toolName: "prepare_scenario_change", args, text: "Check the Preview." }),
    );
    expect(r.error).toBeNull();
    expect(r.proposals).toHaveLength(1);
    expect(r.proposals[0]?.status).toBe("applied");
    expect(r.appliedByHarness).toBe(1);
    expect(r.final.rangeEnd).toBe("2026-11-03");
    expect(r.navigations.length).toBeGreaterThan(0);
  });

  it("ends a trial that never settles with a timeout error, and the next trial starts clean", async () => {
    const hung = await runTrial(
      input(
        { ...base, user: { turns: ["hello"] }, limits: { timeoutMs: 3_000 } },
        { text: "", hang: true },
      ),
    );
    expect(hung.error).toBe("timeout");
    const next = await runTrial(input({ ...base, user: { turns: ["hello"] } }, { text: "Fine." }));
    expect(next.error).toBeNull();
  });
});
