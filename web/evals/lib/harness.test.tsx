// @vitest-environment jsdom
// The harness wiring, proven with a scripted transport: no key, no network. The live
// agent path is proven by the smoke run (plan Task 10).
import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { AbstractAgent, type BaseEvent, type RunAgentInput } from "@ag-ui/client";
import { Observable } from "rxjs";
import type { EvalCase } from "./case";
import { Ledger } from "./budget";
import { runTrial, withShippedClone } from "./harness";
import { useAssistantStore } from "@/lib/ai/assistant/store";
import { createOpenRouterAgent } from "@/lib/ai/runtime/openrouter-agent";

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
  private active: { complete(): void } | null = null;
  constructor(readonly script: { toolName?: string; args?: string; text: string; hang?: boolean }) {
    super({ agentId: "eval", threadId: "t" });
  }
  run(input: RunAgentInput): Observable<BaseEvent> {
    const nth = (this.hop += 1);
    const { toolName, args, text, hang } = this.script;
    return new Observable<BaseEvent>((sub) => {
      const emit = (e: Record<string, unknown>) => sub.next(e as unknown as BaseEvent);
      emit({ type: "RUN_STARTED", threadId: input.threadId, runId: input.runId });
      // Like the real agent, a hung run ends when it is aborted.
      this.active = sub;
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
  override abortRun(): void {
    this.active?.complete();
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

describe("withShippedClone", () => {
  it("clones the real agent like the shipped proxied agent: same identity, no middleware", async () => {
    const agent = withShippedClone(() => createOpenRouterAgent(new Request("https://ward.test/x")));
    agent.agentId = "scheduler:t1";
    agent.threadId = "t1";
    agent.setMessages([{ id: "m1", role: "user", content: "hi" }]);
    // A guard that ends every run, as the session's panel hop guard does for a clone.
    agent.use(() => new Observable<BaseEvent>((sub) => sub.complete()));
    const twice = agent.clone().clone();
    expect(twice.agentId).toBe("scheduler:t1");
    expect(twice.threadId).toBe("t1");
    expect(twice.messages.map((m: { id: string }) => m.id)).toEqual(["m1"]);
    // Keyless, so the run reaches the factory and fails there, not in the dropped guard.
    await expect(twice.runAgent()).rejects.toThrow();
  });
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

  it("finishes a screen the harness never mounts: its bounded waits ignore the pinned day", async () => {
    // The harness pins Date; open_app_screen's anchor poll read Date.now() and spun until
    // the trial timed out whenever the model opened another screen.
    const r = await runTrial(
      input(
        { ...base, user: { turns: ["Where are the shifts?"] } },
        {
          toolName: "open_app_screen",
          args: JSON.stringify({ capabilityId: "shift-types" }),
          text: "Here.",
        },
      ),
    );
    expect(r.error).toBeNull();
    expect(r.navigations).toContain("/shift-types");
    expect(r.transcript.at(-1)).toMatchObject({ role: "assistant", text: "Here." });
  }, 15_000);

  it("records a refused send as a harness error, not a silent empty turn", async () => {
    const r = await runTrial(input({ ...base, user: { turns: ["   "] } }, { text: "unused" }));
    expect(r.error).toBe("refused:empty_message");
  });

  it("records an offered card and picks from it", async () => {
    const args = JSON.stringify({
      question: "Which fix?",
      options: [
        { label: "Borrow a nurse", detail: "" },
        { label: "Move a shift", detail: "" },
      ],
      multiple: false,
    });
    const r = await runTrial(
      input(
        {
          ...base,
          user: { turns: ["Help"], onChoices: { pick: 2 } },
          limits: { timeoutMs: 20_000, maxUserTurns: 2 },
        },
        { toolName: "offer_choices", args, text: "" },
      ),
    );
    expect(r.error).toBeNull();
    expect(r.choices[0]).toEqual({
      question: "Which fix?",
      options: ["Borrow a nurse", "Move a shift"],
    });
    expect(r.transcript.filter((m) => m.role === "user").map((m) => m.text)).toContain(
      "Move a shift",
    );
  });

  it("ends a trial that never settles with a timeout error, and the next trial starts clean", async () => {
    const hung = await runTrial(
      input(
        { ...base, user: { turns: ["hello"] }, limits: { timeoutMs: 3_000 } },
        { text: "", hang: true },
      ),
    );
    expect(hung.error).toBe("timeout");
    // The stop settled before the trial returned: nothing is left to bleed into the next.
    expect(useAssistantStore.getState()).toMatchObject({
      pendingInterruptions: 0,
      interruption: null,
      activeTurnId: null,
    });
    const next = await runTrial(input({ ...base, user: { turns: ["hello"] } }, { text: "Fine." }));
    expect(next.error).toBeNull();
  });
});
