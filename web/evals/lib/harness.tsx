// One eval trial on the SHIPPED path: the real session, proposal controller, follow-ups
// and Apply navigation, under a real CopilotKitProvider. The caller's file owns the two
// module seams (useAgent, next/navigation); this module fills them.
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { AbstractAgent } from "@ag-ui/client";
import type { LanguageModel } from "ai";
import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import { ApplyNavigationNotice } from "@/components/ai/apply-navigation-notice";
import { useAssistantFollowUps } from "@/components/ai/use-assistant-follow-ups";
import {
  useAssistantProposals,
  type AssistantProposalController,
} from "@/components/ai/use-assistant-proposals";
import {
  localAgentId,
  useAssistantSession,
  type AssistantSession,
} from "@/components/ai/use-assistant-session";
import { readThreadMessages, selectActiveThread } from "@/lib/ai/assistant/history-repo";
import { resetRuntimeInstanceForTest } from "@/lib/ai/assistant/runtime-stop";
import { assistantActions, hydrateAssistant, useAssistantStore } from "@/lib/ai/assistant/store";
import { setAssistantDb } from "@/lib/ai/assistant/db";
import { AI_KEY_HEADER, AI_MODEL_HEADER } from "@/lib/ai/runtime/containment";
import { createOpenRouterAgent } from "@/lib/ai/runtime/openrouter-agent";
import { useModeStore } from "@/lib/mode/mode";
import { INITIAL_OPTIMIZE_RUN_VIEW } from "@/lib/optimize/run-view";
import { useRunRequestStore } from "@/lib/optimize/run-request";
import type { AssistantCommandV1 } from "@/lib/proposal";
import { SCENARIOS } from "@/lib/rules/ward-fixtures.test-support";
import type { ImportNormalizationTarget, ScenarioUiState } from "@/lib/scenario/types";
import { importScenarioYaml } from "@/lib/scenario/import-scenario";
import {
  assistantProposalCommands,
  drainScenarioCommands,
  resolveTabId,
  useAuthorityStore,
  useHotStore,
  useScenarioStore,
} from "@/lib/store";
import { pickScenario } from "@/lib/store/fingerprint";
import { loadScenario } from "@/lib/store/lifecycle";
import { clearTestAuthority, installTestAuthority } from "@/lib/store/test-authority";
import { vi } from "vitest";
import type { Ledger } from "./budget";
import { recordingFetch } from "./budget";
import type { EvalCase, Seed, UserPolicy } from "./case";
import { renderTranscript } from "./judge";
import type {
  ChoiceRecord,
  ProposalRecord,
  ToolCallRecord,
  TranscriptEntry,
  TrialRecord,
} from "./trial";
import { nextSimulatedLine } from "./user";

export interface Seams {
  agent: unknown;
  pushes: string[];
}

export interface RunTrialInput {
  evalCase: EvalCase;
  trial: number;
  seams: Seams;
  ledger: Ledger;
  apiKey: string;
  model: string;
  userModel: LanguageModel | null;
  agentFactory?: (fetch: typeof globalThis.fetch) => AbstractAgent;
}

const ORIGIN = "https://ward.test";

/** The keyless load target `loadScenario` takes; it assigns card identity on load. */
export function buildSeed(seed: Seed): ImportNormalizationTarget {
  if ("fixture" in seed) return SCENARIOS[seed.fixture]();
  if ("build" in seed) return seed.build();
  const imported = importScenarioYaml(seed.yaml);
  if (!imported.ok)
    throw new Error(`fixture YAML did not import: ${JSON.stringify(imported.issues)}`);
  return imported.target;
}

interface Handles {
  session: AssistantSession | null;
  controller: AssistantProposalController | null;
  send: ((text: string) => Promise<boolean>) | null;
}

function Session({ threadId, handles }: { threadId: string; handles: Handles }) {
  const session = useAssistantSession({
    threadId,
    routePath: window.location.pathname,
    routeLabel: null,
    historical: false,
  });
  const controller = useAssistantProposals();
  const send = useAssistantFollowUps(session.isRunning, controller.outcome, session.send);
  handles.session = session;
  handles.controller = controller;
  handles.send = send;
  return <ApplyNavigationNotice controller={controller} />;
}

/** Answers CopilotKit's runtime info request locally; everything else goes to `real`. */
function infoStub(real: typeof fetch): typeof fetch {
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).includes("/api/copilotkit")) {
      return new Response(JSON.stringify({ agents: {}, mode: "sse", runtimeInstanceId: "eval" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return real(url, init);
  }) as typeof fetch;
}

function toTranscript(rows: Awaited<ReturnType<typeof readThreadMessages>>): TranscriptEntry[] {
  const results = new Map(
    rows.filter((m) => m.role === "tool").map((m) => [m.toolCallId, m.content]),
  );
  return rows
    .filter((m) => m.role !== "reasoning")
    .map((m) => ({
      role: m.role as TranscriptEntry["role"],
      text: m.content,
      toolCalls: (m.toolCalls ?? []).map((call): ToolCallRecord => {
        let args: unknown = call.args;
        try {
          args = JSON.parse(call.args);
        } catch {
          // Keep the raw string: the grader reports it as it streamed.
        }
        return {
          toolCallId: call.toolCallId,
          name: call.name,
          args,
          result: results.get(call.toolCallId) ?? null,
        };
      }),
    }));
}

export async function runTrial(input: RunTrialInput): Promise<TrialRecord> {
  const { evalCase, seams, ledger } = input;
  // Monotonic clock: `vi.setSystemTime` below pins `Date` to the case's day.
  const started = performance.now();
  const timeoutMs = evalCase.limits?.timeoutMs ?? 180_000;
  const maxUserTurns = evalCase.limits?.maxUserTurns ?? 6;
  const maxHops = evalCase.limits?.maxHops ?? 14;
  const realFetch = globalThis.fetch;
  const recorder = recordingFetch(input.model, ledger, realFetch);
  const handles: Handles = { session: null, controller: null, send: null };
  const choices: ChoiceRecord[] = [];
  const seenChoiceIds = new Set<number>();
  const proposalIds: string[] = [];
  const handledRunEpochs = new Set<number>();
  let appliedByHarness = 0;
  let error: string | null = null;
  const target = buildSeed(evalCase.seed);
  let seed: ScenarioUiState | null = null;
  let threadId = "";
  let runs = 0;

  const observe = () => {
    const st = useAssistantStore.getState();
    if (st.activeChoices && !seenChoiceIds.has(st.activeChoices.id)) {
      seenChoiceIds.add(st.activeChoices.id);
      choices.push({
        question: st.activeChoices.question,
        options: st.activeChoices.options.map((o) => o.label),
      });
    }
    const pid = st.activeProposal?.proposalId;
    if (pid && !proposalIds.includes(pid)) proposalIds.push(pid);
  };

  const userCount = async () =>
    (await readThreadMessages(threadId)).filter((m) => m.role === "user").length;
  const deadline = started + timeoutMs;
  const settle = async () => {
    await waitFor(
      () => {
        const s = handles.session;
        if (!s || s.isRunning || s.sending) throw new Error("busy");
      },
      { timeout: Math.max(1, deadline - performance.now()), interval: 100 },
    );
    await drainScenarioCommands();
    observe();
  };
  /** The follow-up hook sends on its own after Apply or a finished run: wait for it, then settle. */
  const awaitFollowUp = async (before: number) => {
    await waitFor(
      async () => {
        if ((await userCount()) <= before) throw new Error("no follow-up yet");
      },
      { timeout: 10_000, interval: 100 },
    );
    await settle();
  };
  const finishRecordedRun = async (outcome: "infeasible" | "optimal") => {
    const before = await userCount();
    runs += 1;
    act(() => {
      useRunRequestStore.setState({ pending: null, last: "started" });
      useHotStore.getState().setRunView({
        ...INITIAL_OPTIMIZE_RUN_VIEW,
        lifecycle: "completed",
        jobId: `eval_${runs}`,
        outcome,
        result: {
          outcome,
          score: outcome === "infeasible" ? null : 100,
          solverStatus: outcome === "infeasible" ? "INFEASIBLE" : "OPTIMAL",
          terminationReason: null,
        },
      });
    });
    await awaitFollowUp(before);
  };

  try {
    globalThis.fetch = infoStub(realFetch);
    vi.setSystemTime(new Date(`${evalCase.today}T09:00:00+08:00`));
    assistantActions.resetForTest();
    resetRuntimeInstanceForTest();
    // The real `readWriterContext`: it reads the lease and envelope from the assistant
    // database under this tab's id, so both must be the authority's own.
    const authority = await installTestAuthority({ tabId: resolveTabId() });
    setAssistantDb(authority.db);
    const loaded = await loadScenario(target);
    if (!loaded.ok) throw new Error(`seed did not load: ${JSON.stringify(loaded)}`);
    seed = pickScenario(useScenarioStore.getState());
    useModeStore.setState({ mode: "advanced", adoption: "ready" });
    window.history.replaceState({}, "", evalCase.route);
    await hydrateAssistant();
    await assistantActions.setEnabled(true);
    await assistantActions.activate({
      apiKey: input.apiKey,
      modelId: input.model,
      modelSource: "catalog",
    });
    const scenarioId = useAuthorityStore.getState().scenarioId;
    if (!scenarioId) throw new Error("no scenario id after load");
    threadId = (await selectActiveThread(scenarioId)).threadId;

    seams.pushes.length = 0;
    const agent =
      input.agentFactory?.(recorder.fetch) ??
      createOpenRouterAgent(
        new Request(`${ORIGIN}/api/copilotkit`, {
          headers: { [AI_KEY_HEADER]: input.apiKey, [AI_MODEL_HEADER]: input.model },
        }),
        { fetch: recorder.fetch },
      );
    // The id the shipped session's `useAgent` resolves: the production `localAgentId`
    // (built on COPILOT_AGENT_ID), never a copied string. Frontend tools attach by this
    // id, and the provider refuses an agent whose id differs from its registration key.
    const agentId = localAgentId(threadId);
    agent.agentId = agentId;
    seams.agent = agent;
    render(
      <CopilotKitProvider agents__unsafe_dev_only={{ [agentId]: agent }}>
        <Session threadId={threadId} handles={handles} />
      </CopilotKitProvider>,
    );
    await waitFor(() => {
      if (!handles.send) throw new Error("not mounted");
    });

    if (evalCase.afterRunFinished)
      await finishRecordedRun(evalCase.optimizer?.outcome ?? "infeasible");

    const policy: UserPolicy =
      "simulated" in evalCase.user
        ? { turns: [], onPreview: evalCase.user.simulated.onPreview }
        : evalCase.user;
    const turns = [...policy.turns];
    const answers = [...(policy.answers ?? [])];
    let userTurns = 0;
    const say = async (text: string) => {
      userTurns += 1;
      // `send` resolves only when the turn's last write settles, so a run that never
      // ends would hold it forever: race it against the trial deadline.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("busy")),
          Math.max(1, deadline - performance.now()),
        );
      });
      try {
        await Promise.race([handles.send!(text), expired]);
      } finally {
        clearTimeout(timer);
      }
      await settle();
    };

    while (userTurns < maxUserTurns && recorder.hops() < maxHops && !ledger.over) {
      const st = useAssistantStore.getState();
      if (st.activeChoices && policy.onChoices) {
        const opts = st.activeChoices.options.map((o) => o.label);
        const pick =
          "pick" in policy.onChoices
            ? opts[policy.onChoices.pick - 1]
            : opts.find((o) => o.includes((policy.onChoices as { label: string }).label));
        if (pick) {
          await say(pick);
          continue;
        }
      }
      const pid = st.activeProposal?.proposalId;
      const proposal = pid ? await assistantProposalCommands.read(pid) : null;
      const open =
        proposal &&
        (proposal.status === "preview_ready" || proposal.status === "confirmation_required");
      if (open && policy.onPreview === "apply") {
        const before = await userCount();
        for (const a of proposal.assumptions)
          await act(() => handles.controller!.confirm(a.assumptionId));
        await act(() => handles.controller!.apply());
        appliedByHarness += 1;
        await awaitFollowUp(before);
        continue;
      }
      if (open && policy.onPreview === "reject") {
        await act(() => handles.controller!.cancel());
      }
      if (
        st.activeRunRequest &&
        policy.onRunRequest === "run" &&
        !handledRunEpochs.has(st.activeRunRequest.turnEpoch)
      ) {
        handledRunEpochs.add(st.activeRunRequest.turnEpoch);
        await finishRecordedRun(evalCase.optimizer?.outcome ?? "optimal");
        continue;
      }
      const transcriptNow = toTranscript(await readThreadMessages(threadId));
      let next = turns.shift() ?? null;
      if (next === null) {
        const lastText =
          [...transcriptNow].reverse().find((m) => m.role === "assistant" && m.text.trim())?.text ??
          "";
        if (lastText.includes("?") && answers.length > 0) next = answers.shift() ?? null;
      }
      if (next === null && "simulated" in evalCase.user && input.userModel) {
        next = await nextSimulatedLine(
          input.userModel,
          evalCase.user.simulated,
          renderTranscript({ transcript: transcriptNow, appliedByHarness } as TrialRecord),
        );
      }
      if (next === null) break;
      await say(next);
    }
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    error = message.includes("busy") || performance.now() >= deadline ? "timeout" : message;
  }

  // Stop first: a hung provider request must abort before the recorder waits on it.
  handles.session?.stop();
  const rows = threadId ? await readThreadMessages(threadId).catch(() => []) : [];
  const proposals: ProposalRecord[] = [];
  for (const id of proposalIds) {
    const p = await assistantProposalCommands.read(id).catch(() => null);
    if (p)
      proposals.push({ proposalId: id, ops: p.commands as AssistantCommandV1[], status: p.status });
  }
  const final = pickScenario(useScenarioStore.getState());
  const usage = await recorder.settled();
  const record: TrialRecord = {
    caseId: evalCase.id,
    trial: input.trial,
    transcript: toTranscript(rows),
    choices,
    proposals,
    appliedByHarness,
    navigations: [...seams.pushes],
    seed: seed ?? final,
    final,
    usage,
    hops: recorder.hops(),
    ms: Math.round(performance.now() - started),
    error,
  };
  cleanup();
  clearTestAuthority();
  globalThis.fetch = realFetch;
  vi.useRealTimers();
  return record;
}
