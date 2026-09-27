# ypo: auto-compact long assistant conversations (Implementation Plan)

Confidence: 7.0/10

I read the send path end to end. That is `runSend` in `use-assistant-session.ts` (history read, user-message write, final authorization, turn clone) and `createProviderHopGuard` in `turn-authority.ts`. I also read `buildAssistantContext`, `openrouter-agent.ts`, the fenced repo (`history-repo.ts`, `fence.ts`) and the probe route (`lib/ai/openrouter/routes.ts`). One seam makes this small. The hop guard already rewrites each hop's `context`. The same spot can drop the summarised message ids, so the panel, the durable history and the transcript keep every message. What lowers the score:
- The summary call adds a network await to the send's preparation window. The window already tolerates awaits, but the timing is new.
- `generateText` against OpenRouter through `@ai-sdk/openai` `.chat()` is untested here. The agent uses `streamText` the same way.
- The fixed budget (60,000 characters) ignores each model's own context window.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The user can keep chatting in a long conversation. Past a size budget, the assistant summarises the older turns once and sends that summary instead of them. The last 4 user turns stay verbatim. The panel shows a one-line notice that earlier messages were summarised.

**Architecture:** A pure module, `lib/ai/assistant/compaction.ts`, decides when to compact and where to cut. The cut is always on a user-message boundary. This keeps each tool call with its result. At send time, before the final launch authorization, `components/ai/compact-history.ts` asks a new same-origin route, `POST /api/ai/openrouter/summarize`. That route uses the same transient BYO-key pattern as the probe. The result is stored on the thread row (`AssistantThreadV1.summary`) through a fenced write, so Clear deletes it with the thread. Each provider hop then carries the summary as one extra context entry, and the hop guard drops the messages the summary covers. Nothing else changes. The visible panel, Dexie history, receipts and transcript download stay complete.

**Tech Stack:** TypeScript, Next.js 16 route handlers, `ai` 6.0.104 (`generateText`), `@ai-sdk/openai` 3.0.36, Dexie 4, Zod, Vitest, Testing Library.

**Spec:** bead `nursing-sheduler-ypo`. Its notes hold the user decision of 2026-09-26: auto-compact, do not drop. For a long history, summarise the older turns so the user can keep chatting. Keep the recent turns verbatim. Show a one-line notice that earlier messages were summarised. Background: `docs/ai-assistant.md` ("What leaves your browser").

## Global Constraints

- **Branch.** From `/home/kenan/work/nursing-sheduler`, run `wt switch --create feat/ypo-history-compact --base develop --no-cd`. The worktree is `/home/kenan/work/nursing-sheduler.feat-ypo-history-compact` (`$WT`). Do not push. Merging needs the user's approval.
- **Web gate, before every commit** (from `$WT/web`): `pnpm vitest run <focused files>`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`.
- **Library-first testing.** Use Vitest with `fake-indexeddb` (already used by the assistant suites) and a stubbed `fetch`. No parser and no `node:fs`.
- **Credential containment.** The key travels only as `AI_KEY_HEADER` on the summary request. It never goes in the body, the summary, the thread row or a log. The route test scans for `SENTINEL`, as `routes.test.ts` does.
- **No new authority path.** Compaction runs in the preparation zone of `runSend`, above `authorizeLaunchAuthority`. A Stop, Clear, takeover or key removal during the summary call is refused by the existing checks after it. The summary write is fenced by the turn's captured generations.
- **Fail open, never drop silently.** A failed summary call does not stop the turn. The turn goes on with the previous summary, or with none. Without a new summary, nothing new is omitted.
- **Commits:** conventional messages ending `(ypo)`. Run `bd update nursing-sheduler-ypo --claim` first, and `bd close` at the end.

## Decisions taken (minor, delegated)

- **Budget:** `COMPACT_AT_CHARS = 60_000`. This counts the characters of the not-yet-summarised history (content plus tool-call names and arguments) plus the current summary. It is roughly 15k tokens, well under every tool-capable model in the catalog.
- **Kept verbatim:** the last `KEEP_RECENT_USER_TURNS = 4` user turns, with everything after them. Compaction is skipped while the history holds 4 user turns or fewer.
- **Rolling summary:** the next compaction summarises the previous summary plus the next slice, so there is only ever one summary.
- **Summary size:** at most 250 words (`maxOutputTokens: 700`).
- **What goes to the summariser:** user and assistant text, "Assistant used <tool>." for each call, and tool results cut to 600 characters. Reasoning is skipped. The input is capped at `MAX_SUMMARY_INPUT_CHARS = 120_000`, keeping the newest part.
- **Notice copy (panel, one line):** `Earlier messages were summarised to keep this conversation going.` It shows for as long as the thread has a summary.
- **Activity line while summarising:** `Summarising earlier messages…`.
- **Model:** the user's selected model. There is no second model setting (YAGNI).

## Review Focus

- A thread over budget sends the summary plus only the kept messages on the FIRST hop. The panel (`agent.messages`) and Dexie still hold every message.
- A summary call that fails (network, 401, 429) still sends the turn, with the full history and no notice.
- A Clear during the summary call leaves no summary behind: `saveThreadSummary` returns `"fenced"` or `"missing"`.
- A cut never separates an assistant tool call from its result (the cut is always just before a user message).
- A second compaction replaces the first summary. Its `throughSeq` only moves forward.

## Interfaces fixed by this plan

```ts
// web/lib/ai/assistant/records.ts (Task 2)
export interface ThreadSummaryV1 {
  text: string;
  /** Every message with seq <= throughSeq is covered by `text` and is not sent. */
  throughSeq: number;
  createdAt: string;
}
// AssistantThreadV1 gains: summary?: ThreadSummaryV1 | null;

// web/lib/ai/assistant/compaction.ts (Task 1)
export const COMPACT_AT_CHARS = 60_000;
export const KEEP_RECENT_USER_TURNS = 4;
export const MAX_SUMMARY_INPUT_CHARS = 120_000;
export const COMPACTION_NOTICE = "Earlier messages were summarised to keep this conversation going.";
export interface CompactionPlan { throughSeq: number; slice: AssistantMessageV1[] }
export function historyChars(records: readonly AssistantMessageV1[]): number;
export function planCompaction(records: readonly AssistantMessageV1[], summary: ThreadSummaryV1 | null): CompactionPlan | null;
export function omittedMessageIds(records: readonly AssistantMessageV1[], summary: ThreadSummaryV1 | null): Set<string>;
export function transcriptForSummary(slice: readonly AssistantMessageV1[]): string;

// web/lib/ai/assistant/history-repo.ts (Task 2)
export async function saveThreadSummary(
  threadId: string, scenarioId: string, summary: ThreadSummaryV1,
  generations: AssistantGenerationPair, config?: HistoryRepoConfig,
): Promise<WriteOutcome>;

// web/lib/ai/protocol.ts (Task 3)
export const AI_SUMMARY_URL = "/api/ai/openrouter/summarize";
// AI_SETUP_CODES gains: summaryInvalid: "ai_summary_invalid"

// web/lib/ai/openrouter/summarize.ts (Task 3)
export type SummaryResult = { ok: true; summary: string } | { ok: false; code: AiSetupCode };
export async function summarizeConversation(input: {
  apiKey: string; model: string; previousSummary: string | null; transcript: string;
  fetchImpl?: typeof fetch; signal?: AbortSignal;
}): Promise<SummaryResult>;

// web/components/ai/compact-history.ts (Task 4)
export interface CompactedHistory { summary: ThreadSummaryV1 | null; compactedNow: boolean }
export async function compactHistory(input: {
  threadId: string; scenarioId: string; history: readonly AssistantMessageV1[];
  generations: AssistantGenerationPair;
}, deps?: Partial<CompactHistoryDeps>): Promise<CompactedHistory>;

// web/components/ai/turn-authority.ts (Task 5)
// ProviderHopGuardDeps gains: omitMessageIds?: ReadonlySet<string>;
// web/lib/ai/assistant/scenario-context.ts (Task 5)
// BuildContextInput gains: earlierSummary?: string | null;
```

---

### Task 1: Pure compaction rules

**Files:**
- Create: `web/lib/ai/assistant/compaction.ts`
- Test: `web/lib/ai/assistant/compaction.test.ts`

**Interfaces:** Produces everything listed under `compaction.ts` above. It consumes `AssistantMessageV1` and `ThreadSummaryV1` (Task 2 owns that type. It is one interface, so add it to `records.ts` here and let Task 2 reuse it).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import type { AssistantMessageV1 } from "./records";
import {
  COMPACT_AT_CHARS,
  KEEP_RECENT_USER_TURNS,
  historyChars,
  omittedMessageIds,
  planCompaction,
  transcriptForSummary,
} from "./compaction";

let seq = 0;
function row(role: AssistantMessageV1["role"], content: string, extra: Partial<AssistantMessageV1> = {}): AssistantMessageV1 {
  seq += 1;
  return {
    messageId: `m${seq}`, schemaVersion: 1, threadId: "t", scenarioId: "s", seq, role, content,
    toolCalls: null, toolCallId: null, modelId: null, turnId: null,
    globalGeneration: 0, scenarioGeneration: 0, createdAt: "2026-09-27T00:00:00.000Z", ...extra,
  };
}
/** n turns of: user, assistant tool call, tool result, assistant answer. */
function turns(n: number, size = 4_000): AssistantMessageV1[] {
  return Array.from({ length: n }, (_, i) => [
    row("user", `question ${i} ${"q".repeat(size)}`),
    row("assistant", "", { toolCalls: [{ toolCallId: `c${i}`, name: "get_roster", args: "{}" }] }),
    row("tool", "r".repeat(size), { toolCallId: `c${i}` }),
    row("assistant", `answer ${i}`),
  ]).flat();
}

describe("planCompaction", () => {
  it("does nothing under the budget", () => {
    const records = turns(3, 100);
    expect(historyChars(records)).toBeLessThan(COMPACT_AT_CHARS);
    expect(planCompaction(records, null)).toBeNull();
  });

  it("cuts just before the 4th-from-last user message, keeping tool pairs whole", () => {
    const records = turns(10);
    const plan = planCompaction(records, null)!;
    const firstKept = records.filter((r) => r.role === "user").at(-KEEP_RECENT_USER_TURNS)!;
    expect(plan.throughSeq).toBe(firstKept.seq - 1);
    expect(plan.slice.at(-1)!.role).toBe("assistant");
    expect(plan.slice.every((r) => r.seq <= plan.throughSeq)).toBe(true);
  });

  it("never compacts 4 or fewer user turns, however large", () => {
    expect(planCompaction(turns(KEEP_RECENT_USER_TURNS, 30_000), null)).toBeNull();
  });

  it("rolls forward from an existing summary and only counts what it does not cover", () => {
    const records = turns(10);
    const first = planCompaction(records, null)!;
    const summary = { text: "s", throughSeq: first.throughSeq, createdAt: "x" };
    expect(planCompaction(records, summary)).toBeNull();
    const more = [...records, ...turns(10)];
    expect(planCompaction(more, summary)!.throughSeq).toBeGreaterThan(first.throughSeq);
    expect(planCompaction(more, summary)!.slice[0].seq).toBe(first.throughSeq + 1);
  });

  it("omits exactly the covered messages", () => {
    const records = turns(10);
    const plan = planCompaction(records, null)!;
    const ids = omittedMessageIds(records, { text: "s", throughSeq: plan.throughSeq, createdAt: "x" });
    expect([...ids]).toEqual(plan.slice.map((r) => r.messageId));
    expect(omittedMessageIds(records, null).size).toBe(0);
  });
});

describe("transcriptForSummary", () => {
  it("keeps the words, names the tools, trims results and skips reasoning", () => {
    const text = transcriptForSummary([
      row("user", "Ana is on leave on 3 Nov"),
      row("assistant", "", { toolCalls: [{ toolCallId: "c", name: "get_roster", args: "{}" }] }),
      row("tool", "x".repeat(2_000), { toolCallId: "c" }),
      row("reasoning", "secret thinking"),
      row("assistant", "Noted."),
    ]);
    expect(text).toContain("User: Ana is on leave on 3 Nov");
    expect(text).toContain("Assistant used get_roster.");
    expect(text).toContain("Assistant: Noted.");
    expect(text).not.toContain("secret thinking");
    expect(text).not.toContain("x".repeat(601));
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd /home/kenan/work/nursing-sheduler.feat-ypo-history-compact/web && pnpm vitest run lib/ai/assistant/compaction.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `compaction.ts`**

```ts
// When a long conversation is summarised, and where it is cut (bead ypo).
//
// Pure. The cut is always just before a user message, so an assistant tool call and
// its result are never split. Only what the provider receives changes: the panel,
// the durable history and the transcript keep every message.

import type { AssistantMessageV1, ThreadSummaryV1 } from "./records";

export const COMPACT_AT_CHARS = 60_000;
export const KEEP_RECENT_USER_TURNS = 4;
export const MAX_SUMMARY_INPUT_CHARS = 120_000;
const TOOL_RESULT_CHARS = 600;
export const COMPACTION_NOTICE =
  "Earlier messages were summarised to keep this conversation going.";

export interface CompactionPlan {
  throughSeq: number;
  slice: AssistantMessageV1[];
}

export function historyChars(records: readonly AssistantMessageV1[]): number {
  return records.reduce(
    (sum, r) =>
      sum +
      r.content.length +
      (r.toolCalls ?? []).reduce((n, call) => n + call.name.length + call.args.length, 0),
    0,
  );
}

const bySeq = (records: readonly AssistantMessageV1[]) =>
  [...records].sort((a, b) => a.seq - b.seq);

export function planCompaction(
  records: readonly AssistantMessageV1[],
  summary: ThreadSummaryV1 | null,
): CompactionPlan | null {
  const open = bySeq(records).filter((r) => summary === null || r.seq > summary.throughSeq);
  if (historyChars(open) + (summary?.text.length ?? 0) <= COMPACT_AT_CHARS) return null;
  const users = open.filter((r) => r.role === "user");
  // ponytail: a few huge turns stay unsummarised; cut inside a turn if that ever bites.
  if (users.length <= KEEP_RECENT_USER_TURNS) return null;
  const firstKept = users[users.length - KEEP_RECENT_USER_TURNS].seq;
  const slice = open.filter((r) => r.seq < firstKept);
  return { throughSeq: slice[slice.length - 1].seq, slice };
}

export function omittedMessageIds(
  records: readonly AssistantMessageV1[],
  summary: ThreadSummaryV1 | null,
): Set<string> {
  if (summary === null) return new Set();
  return new Set(records.filter((r) => r.seq <= summary.throughSeq).map((r) => r.messageId));
}

export function transcriptForSummary(slice: readonly AssistantMessageV1[]): string {
  const lines = bySeq(slice).flatMap((r): string[] => {
    switch (r.role) {
      case "user":
        return [`User: ${r.content}`];
      case "assistant":
        return [
          ...(r.content ? [`Assistant: ${r.content}`] : []),
          ...(r.toolCalls ?? []).map((call) => `Assistant used ${call.name}.`),
        ];
      case "tool":
        return [
          `Result: ${r.content.length > TOOL_RESULT_CHARS ? `${r.content.slice(0, TOOL_RESULT_CHARS)}…` : r.content}`,
        ];
      case "reasoning":
        return [];
    }
  });
  const text = lines.join("\n");
  return text.length > MAX_SUMMARY_INPUT_CHARS ? text.slice(-MAX_SUMMARY_INPUT_CHARS) : text;
}
```

- [ ] **Step 4: Run it and see it pass.** Same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/kenan/work/nursing-sheduler.feat-ypo-history-compact && git add web/lib/ai/assistant/compaction.ts web/lib/ai/assistant/compaction.test.ts web/lib/ai/assistant/records.ts
git commit -m "feat(assistant): plan when and where to compact a long thread (ypo)"
```

### Task 2: Store the summary on the thread, fenced

**Files:**
- Modify: `web/lib/ai/assistant/records.ts` (`ThreadSummaryV1`, `AssistantThreadV1.summary?`)
- Modify: `web/lib/ai/assistant/history-repo.ts` (add `saveThreadSummary` after `persistThreadMessages`)
- Test: `web/lib/ai/assistant/history-repo.test.ts`

No Dexie version bump is needed: `summary` is not indexed. Clear already deletes the whole thread row (`clear-repo.ts`), so the summary goes with it.

- [ ] **Step 1: Write the failing test** (append to `history-repo.test.ts`. Add `saveThreadSummary` and `readThread` to its `./history-repo` import, `beginClear` and `finishClear` from `./clear-repo`, and `dumpDatabase` from `./test-support`):

```ts
describe("thread summary (bead ypo)", () => {
  const summary = { text: "Ana asked for 3 Nov off.", throughSeq: 7, createdAt: "2026-09-27T00:00:00.000Z" };
  const fresh = { globalGeneration: 0, scenarioGeneration: 0 };

  it("stores the summary on the live thread and replaces it on the next compaction", async () => {
    const harness = createAssistantHarness();
    const thread = await selectActiveThread("scenario-a", harness.config);
    expect(await saveThreadSummary(thread.threadId, "scenario-a", summary, fresh, harness.config)).toBe("accepted");
    const next = { ...summary, text: "Later.", throughSeq: 20 };
    expect(await saveThreadSummary(thread.threadId, "scenario-a", next, fresh, harness.config)).toBe("accepted");
    expect((await readThread(thread.threadId, harness.config))?.summary).toEqual(next);
  });

  it("drops a summary for a cleared thread or a stale generation", async () => {
    const harness = createAssistantHarness();
    const thread = await selectActiveThread("scenario-a", harness.config);
    const stale = { globalGeneration: 9, scenarioGeneration: 9 };
    expect(await saveThreadSummary(thread.threadId, "scenario-a", summary, stale, harness.config)).toBe("fenced");
    await harness.db.assistantThreads.update(thread.threadId, { state: "cleared" });
    expect(await saveThreadSummary(thread.threadId, "scenario-a", summary, fresh, harness.config)).toBe("missing");
    expect((await harness.db.assistantThreads.get(thread.threadId))?.summary ?? null).toBeNull();
  });

  it("is deleted by Clear conversation history", async () => {
    const harness = createAssistantHarness();
    const thread = await selectActiveThread("scenario-a", harness.config);
    await saveThreadSummary(thread.threadId, "scenario-a", summary, fresh, harness.config);
    await finishClear(await beginClear("history", "scenario-a", harness.config), harness.config);
    expect(JSON.stringify(await dumpDatabase(harness.db))).not.toContain("Ana asked for 3 Nov off.");
  });

  it("never moves backwards", async () => {
    const harness = createAssistantHarness();
    const thread = await selectActiveThread("scenario-a", harness.config);
    await saveThreadSummary(thread.threadId, "scenario-a", { ...summary, throughSeq: 20 }, fresh, harness.config);
    expect(await saveThreadSummary(thread.threadId, "scenario-a", summary, fresh, harness.config)).toBe("fenced");
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd /home/kenan/work/nursing-sheduler.feat-ypo-history-compact/web && pnpm vitest run lib/ai/assistant/history-repo.test.ts`
Expected: FAIL (`saveThreadSummary` is not exported).

- [ ] **Step 3: Implement**

`records.ts`: add `ThreadSummaryV1` (from "Interfaces" above) and, on `AssistantThreadV1`:

```ts
  /** bead ypo: the rolling summary of older messages, or absent. Deleted with the thread. */
  summary?: ThreadSummaryV1 | null;
```

`history-repo.ts`:

```ts
/**
 * Store a thread's rolling summary (bead ypo). Fenced like every assistant write: a
 * Clear that bumped the generation, or marked the thread cleared, drops it. A summary
 * that would cover less than the stored one is dropped too.
 */
export async function saveThreadSummary(
  threadId: string,
  scenarioId: string,
  summary: ThreadSummaryV1,
  generations: AssistantGenerationPair,
  config: HistoryRepoConfig = {},
): Promise<WriteOutcome> {
  const { db, now } = resolve(config);
  const result = await runFenced(
    db,
    ASSISTANT_WRITE_TABLES,
    fromGenerationPair(scenarioId, generations),
    async () => {
      const thread = await db.assistantThreads.get(threadId);
      if (!thread || thread.state === "cleared") return "missing" as const;
      if ((thread.summary?.throughSeq ?? -1) >= summary.throughSeq) return "fenced" as const;
      await db.assistantThreads.put({ ...thread, summary, updatedAt: now().toISOString() });
      return "accepted" as const;
    },
  );
  return result.outcome === "fenced" ? "fenced" : result.value;
}
```

Import `ThreadSummaryV1` in the existing `./records` type import.

- [ ] **Step 4: Run it and see it pass.** Same command, plus `lib/ai/assistant/clear-*.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/kenan/work/nursing-sheduler.feat-ypo-history-compact && git add web/lib/ai/assistant/records.ts web/lib/ai/assistant/history-repo.ts web/lib/ai/assistant/history-repo.test.ts
git commit -m "feat(assistant): keep a fenced rolling summary on the thread (ypo)"
```

### Task 3: The summary route

**Files:**
- Modify: `web/lib/ai/protocol.ts` (`AI_SUMMARY_URL`, `AI_SETUP_CODES.summaryInvalid`)
- Modify: `web/lib/ai/openrouter/probe.ts` (export `classifyStatus`. It is unchanged otherwise)
- Create: `web/lib/ai/openrouter/summarize.ts`
- Modify: `web/lib/ai/openrouter/routes.ts` (add `handleSummaryRequest`)
- Create: `web/app/api/ai/openrouter/summarize/route.ts`
- Test: `web/lib/ai/openrouter/routes.test.ts`

`app/api/ai/**` is already an AI owner in `oxlint-boundary-config.test.ts` (`AI_OWNERS`), so no lint config changes.

- [ ] **Step 1: Write the failing test** (append to `routes.test.ts`, which already has `SENTINEL`, `MODEL`, `credentialHeaders()`):

```ts
import { handleSummaryRequest } from "./routes";

function summaryRequest(body: unknown, headers = credentialHeaders()): Request {
  return new Request("https://app.test/api/ai/openrouter/summarize", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
const completion = (text: string) =>
  new Response(
    JSON.stringify({
      id: "gen-1", object: "chat.completion", created: 0, model: MODEL,
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

describe("POST /api/ai/openrouter/summarize (bead ypo)", () => {
  it("returns the model's summary and keeps the key out of the body and the answer", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return completion("Ana wants 3 Nov off.");
    };
    const response = await handleSummaryRequest(
      summaryRequest({ previousSummary: null, transcript: "User: Ana wants 3 Nov off." }),
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    const body = await response.json();
    expect(body).toEqual({ ok: true, summary: "Ana wants 3 Nov off." });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(calls[0].url).toMatch(/\/chat\/completions$/);
    expect(String(calls[0].init.body)).not.toContain(SENTINEL);
    expect(String(calls[0].init.body)).toContain("Ana wants 3 Nov off.");
    expect(JSON.stringify(body)).not.toContain(SENTINEL);
  });

  it("classifies a provider refusal and forwards none of its body", async () => {
    const fetchImpl = async () => new Response("quota for sk-or-v1-LEAK", { status: 429 });
    const response = await handleSummaryRequest(
      summaryRequest({ previousSummary: null, transcript: "x" }),
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(await response.json()).toEqual({ ok: false, code: "ai_provider_declined" });
  });

  it("refuses a missing key, and an empty or oversized transcript, without calling out", async () => {
    const fetchImpl = vi.fn();
    const opts = { fetchImpl: fetchImpl as unknown as typeof fetch };
    expect((await handleSummaryRequest(summaryRequest({ previousSummary: null, transcript: "x" }, {}), opts)).status).toBe(400);
    expect(await (await handleSummaryRequest(summaryRequest({ previousSummary: null, transcript: "" }), opts)).json())
      .toEqual({ ok: false, code: "ai_summary_invalid" });
    expect(await (await handleSummaryRequest(summaryRequest({ previousSummary: null, transcript: "x".repeat(120_001) }), opts)).json())
      .toEqual({ ok: false, code: "ai_summary_invalid" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
```

(Add `vi` to the file's vitest import, unless it is there already.)

- [ ] **Step 2: Run it and see it fail**

Run: `cd /home/kenan/work/nursing-sheduler.feat-ypo-history-compact/web && pnpm vitest run lib/ai/openrouter/routes.test.ts`
Expected: FAIL (`handleSummaryRequest` is not exported).

- [ ] **Step 3: Implement**

`protocol.ts`:

```ts
export const AI_SUMMARY_URL = "/api/ai/openrouter/summarize";
```

and in `AI_SETUP_CODES`:

```ts
  /** A summary request with no transcript, or one too large to send. */
  summaryInvalid: "ai_summary_invalid",
```

`probe.ts`: change `function classifyStatus(` to `export function classifyStatus(`.

`summarize.ts`:

```ts
// One summary of older conversation turns (bead ypo). Same containment as the probe:
// the key is used for this one request and dropped, and an upstream body is only
// ever classified, never forwarded.

import { createOpenAI } from "@ai-sdk/openai";
import { APICallError, generateText } from "ai";
import { AI_SETUP_CODES, OPENROUTER_BASE_URL, type AiSetupCode } from "@/lib/ai/protocol";
import { classifyStatus } from "./probe";

export type SummaryResult = { ok: true; summary: string } | { ok: false; code: AiSetupCode };

const SYSTEM =
  "You summarise the earlier part of a conversation between a nurse manager and a " +
  "scheduling assistant, so the assistant can carry on without it. Keep: decisions the " +
  "user made, facts they stated (names, dates, shifts, leave, preferences), changes " +
  "proposed and whether they were applied, optimiser runs and their results, and open " +
  "questions. Drop small talk and tool payload detail: the current schedule is sent " +
  "separately. Plain sentences, at most 250 words.";

export async function summarizeConversation(input: {
  apiKey: string;
  model: string;
  previousSummary: string | null;
  transcript: string;
  fetchImpl?: typeof globalThis.fetch;
  signal?: AbortSignal;
}): Promise<SummaryResult> {
  const openrouter = createOpenAI({
    apiKey: input.apiKey,
    baseURL: OPENROUTER_BASE_URL,
    ...(input.fetchImpl ? { fetch: input.fetchImpl } : {}),
  });
  const prompt =
    (input.previousSummary ? `Summary so far:\n${input.previousSummary}\n\n` : "") +
    `Conversation to add:\n${input.transcript}`;
  try {
    const { text } = await generateText({
      // `.chat()`: OpenRouter does not implement the Responses API (see openrouter-agent.ts).
      model: openrouter.chat(input.model),
      system: SYSTEM,
      prompt,
      maxOutputTokens: 700,
      maxRetries: 0,
      ...(input.signal ? { abortSignal: input.signal } : {}),
    });
    const summary = text.trim();
    return summary ? { ok: true, summary } : { ok: false, code: AI_SETUP_CODES.probeFailed };
  } catch (error) {
    if (APICallError.isInstance(error) && error.statusCode !== undefined) {
      return { ok: false, code: classifyStatus(error.statusCode, error.responseBody ?? "") };
    }
    return { ok: false, code: AI_SETUP_CODES.providerUnreachable };
  }
}
```

`routes.ts` (reuses `contained`):

```ts
const summaryBody = z.object({
  previousSummary: z.string().max(8_000).nullable(),
  transcript: z.string().min(1).max(MAX_SUMMARY_INPUT_CHARS),
});

/** `POST /api/ai/openrouter/summarize` (bead ypo). The key is a transient header, as for the probe. */
export async function handleSummaryRequest(
  request: Request,
  options: ProbeHandlerOptions = {},
): Promise<Response> {
  const apiKey = request.headers.get(AI_KEY_HEADER)?.trim();
  const model = request.headers.get(AI_MODEL_HEADER)?.trim();
  if (!apiKey || !model) {
    return contained({ ok: false, code: AI_SETUP_CODES.credentialsRequired }, 400);
  }
  const parsed = summaryBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return contained({ ok: false, code: AI_SETUP_CODES.summaryInvalid });
  return contained(
    await summarizeConversation({
      apiKey,
      model,
      ...parsed.data,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(request.signal ? { signal: request.signal } : {}),
    }),
  );
}
```

Add the imports: `z` from `"zod"`, `MAX_SUMMARY_INPUT_CHARS` from `"@/lib/ai/assistant/compaction"`, and `summarizeConversation` from `"./summarize"`. Check `lib/ai/independence.test.ts` still passes. If it forbids `lib/ai/openrouter` from importing `lib/ai/assistant`, restate the constant as `120_000` locally, with a comment that names `compaction.ts`.

`app/api/ai/openrouter/summarize/route.ts`:

```ts
import { handleSummaryRequest } from "@/lib/ai/openrouter/routes";

// Older-turn summary (bead ypo). Node runtime and `force-dynamic`: the BYO credential
// arrives as a request header, so nothing here may be cached or reused.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return handleSummaryRequest(request);
}
```

- [ ] **Step 4: Run it and see it pass**

Run: `cd /home/kenan/work/nursing-sheduler.feat-ypo-history-compact/web && pnpm vitest run lib/ai/openrouter lib/ai/protocol.test.ts lib/ai/independence.test.ts oxlint-boundary-config.test.ts`
Expected: PASS. If `generateText` sends a request shape the fixture does not match (for example `stream: true`), fix the fixture, not the production call. The AI SDK owns that wire format.

- [ ] **Step 5: Gate and commit**

```bash
cd /home/kenan/work/nursing-sheduler.feat-ypo-history-compact/web && pnpm typecheck && pnpm lint && pnpm format:check
cd .. && git add web/lib/ai/protocol.ts web/lib/ai/openrouter web/app/api/ai/openrouter/summarize
git commit -m "feat(assistant): summary route for older conversation turns (ypo)"
```

### Task 4: `compactHistory`, the client step

**Files:**
- Create: `web/components/ai/compact-history.ts`
- Test: `web/components/ai/compact-history.test.ts`

**Interfaces:** Consumes Task 1, Task 2 (`saveThreadSummary`, `readThread`), Task 3 (`AI_SUMMARY_URL`), and `readAssistantSettings` / `isAssistantReady` (`lib/ai/assistant/settings-repo.ts`, `records.ts`). Produces `compactHistory` and `CompactedHistory`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from "vitest";
import { compactHistory } from "./compact-history";
import type { AssistantMessageV1, AssistantSettingsV1 } from "@/lib/ai/assistant/records";
import { AI_KEY_HEADER } from "@/lib/ai/protocol";

const ready = { enabled: true, apiKey: "sk-or-TEST", modelId: "m" } as AssistantSettingsV1;
const big = (n: number): AssistantMessageV1[] =>
  Array.from({ length: n }, (_, i) => ({
    messageId: `m${i}`, schemaVersion: 1, threadId: "t", scenarioId: "s", seq: i,
    role: i % 2 === 0 ? "user" : "assistant", content: "x".repeat(8_000),
    toolCalls: null, toolCallId: null, modelId: null, turnId: null,
    globalGeneration: 0, scenarioGeneration: 0, createdAt: "2026-09-27T00:00:00.000Z",
  })) as AssistantMessageV1[];
const input = (history: AssistantMessageV1[]) => ({
  threadId: "t", scenarioId: "s", history, generations: { globalGeneration: 0, scenarioGeneration: 0 },
});

describe("compactHistory", () => {
  it("summarises an over-budget thread once and stores it", async () => {
    const save = vi.fn(async () => "accepted" as const);
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true, summary: "S" })));
    const out = await compactHistory(input(big(20)), {
      readThread: async () => ({ summary: null }) as never,
      readSettings: async () => ready,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      saveThreadSummary: save,
      now: () => new Date("2026-09-27T01:00:00.000Z"),
    });
    expect(out.compactedNow).toBe(true);
    expect(out.summary).toMatchObject({ text: "S", throughSeq: 11 });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)[AI_KEY_HEADER]).toBe("sk-or-TEST");
    expect(String(init.body)).not.toContain("sk-or-TEST");
    expect(save).toHaveBeenCalledOnce();
  });

  it("keeps the old summary when the call fails or the write is fenced", async () => {
    const old = { text: "old", throughSeq: 1, createdAt: "x" };
    const deps = {
      readThread: async () => ({ summary: old }) as never,
      readSettings: async () => ready,
      saveThreadSummary: async () => "fenced" as const,
    };
    const failed = await compactHistory(input(big(20)), {
      ...deps,
      fetchImpl: (async () => new Response(JSON.stringify({ ok: false, code: "ai_provider_declined" }))) as unknown as typeof fetch,
    });
    expect(failed).toEqual({ summary: old, compactedNow: false });
    const fenced = await compactHistory(input(big(20)), {
      ...deps,
      fetchImpl: (async () => new Response(JSON.stringify({ ok: true, summary: "S" }))) as unknown as typeof fetch,
    });
    expect(fenced).toEqual({ summary: old, compactedNow: false });
  });

  it("does no request under the budget", async () => {
    const fetchImpl = vi.fn();
    const out = await compactHistory(input(big(3)), {
      readThread: async () => ({ summary: null }) as never,
      readSettings: async () => ready,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(out).toEqual({ summary: null, compactedNow: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd /home/kenan/work/nursing-sheduler.feat-ypo-history-compact/web && pnpm vitest run components/ai/compact-history.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `compact-history.ts`**

```ts
"use client";

// Summarise the older part of a long thread before a send (bead ypo). Fails open: any
// failure keeps the previous summary (or none), and the turn goes on as before.

import { planCompaction, transcriptForSummary } from "@/lib/ai/assistant/compaction";
import type { AssistantGenerationPair } from "@/lib/ai/assistant/fence";
import { readThread, saveThreadSummary } from "@/lib/ai/assistant/history-repo";
import { isAssistantReady, type AssistantMessageV1, type ThreadSummaryV1 } from "@/lib/ai/assistant/records";
import { readAssistantSettings } from "@/lib/ai/assistant/settings-repo";
import { AI_KEY_HEADER, AI_MODEL_HEADER, AI_SUMMARY_URL } from "@/lib/ai/protocol";

export interface CompactedHistory {
  summary: ThreadSummaryV1 | null;
  compactedNow: boolean;
}

export interface CompactHistoryDeps {
  readThread: typeof readThread;
  readSettings: typeof readAssistantSettings;
  saveThreadSummary: typeof saveThreadSummary;
  fetchImpl: typeof globalThis.fetch;
  now: () => Date;
}

export async function compactHistory(
  input: {
    threadId: string;
    scenarioId: string;
    history: readonly AssistantMessageV1[];
    generations: AssistantGenerationPair;
  },
  overrides: Partial<CompactHistoryDeps> = {},
): Promise<CompactedHistory> {
  const deps: CompactHistoryDeps = {
    readThread,
    readSettings: readAssistantSettings,
    saveThreadSummary,
    fetchImpl: (...args) => globalThis.fetch(...args),
    now: () => new Date(),
    ...overrides,
  };
  const previous = (await deps.readThread(input.threadId))?.summary ?? null;
  const plan = planCompaction(input.history, previous);
  if (plan === null) return { summary: previous, compactedNow: false };
  const settings = await deps.readSettings();
  if (!isAssistantReady(settings)) return { summary: previous, compactedNow: false };
  try {
    const response = await deps.fetchImpl(AI_SUMMARY_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [AI_KEY_HEADER]: settings.apiKey,
        [AI_MODEL_HEADER]: settings.modelId,
      },
      body: JSON.stringify({
        previousSummary: previous?.text ?? null,
        transcript: transcriptForSummary(plan.slice),
      }),
    });
    const body = (await response.json()) as { ok: boolean; summary?: string };
    if (!body.ok || !body.summary) return { summary: previous, compactedNow: false };
    const next: ThreadSummaryV1 = {
      text: body.summary,
      throughSeq: plan.throughSeq,
      createdAt: deps.now().toISOString(),
    };
    const outcome = await deps.saveThreadSummary(
      input.threadId,
      input.scenarioId,
      next,
      input.generations,
    );
    return outcome === "accepted"
      ? { summary: next, compactedNow: true }
      : { summary: previous, compactedNow: false };
  } catch {
    return { summary: previous, compactedNow: false };
  }
}
```

- [ ] **Step 4: Run it and see it pass.** Same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/kenan/work/nursing-sheduler.feat-ypo-history-compact && git add web/components/ai/compact-history.ts web/components/ai/compact-history.test.ts
git commit -m "feat(assistant): summarise an over-budget thread before a send (ypo)"
```

### Task 5: Wire it into the send, the hop and the panel

**Files:**
- Modify: `web/components/ai/turn-authority.ts` (`ProviderHopGuardDeps.omitMessageIds`, `authorizedInput`, ~line 305)
- Modify: `web/lib/ai/assistant/scenario-context.ts` (`BuildContextInput.earlierSummary`, `buildAssistantContext`)
- Modify: `web/components/ai/use-assistant-session.ts` (`AssistantActivity`, `runSend` between the user-message persist ~line 468 and `authorizeLaunchAuthority` ~line 475, the guard deps ~line 578, hydration, the returned `AssistantSession`)
- Modify: `web/components/ai/assistant-conversation.tsx` (activity label, `CompactionNotice`)
- Modify: `docs/ai-assistant.md` ("What leaves your browser")
- Test: `web/components/ai/session-persistence.test.tsx`, `web/lib/ai/assistant/scenario-context.test.ts`, `web/components/ai/assistant-activity.test.tsx`

**Interfaces:** Consumes `compactHistory` (Task 4), `omittedMessageIds` and `COMPACTION_NOTICE` (Task 1). Produces `AssistantSession.summarised: boolean`, plus the activity `{ kind: "summarising" }`.

- [ ] **Step 1: Write the failing tests**

`scenario-context.test.ts`:

```ts
it("adds the earlier-conversation summary as its own context entry (ypo)", () => {
  const base = { scenario: createEmptyScenarioUiState(), scenarioId: "s", documentRevision: 1, routePath: "/", routeLabel: null };
  expect(buildAssistantContext(base).some((e) => /earlier part of this conversation/.test(e.description))).toBe(false);
  const entry = buildAssistantContext({ ...base, earlierSummary: "Ana wants 3 Nov off." })
    .find((e) => /earlier part of this conversation/.test(e.description));
  expect(entry?.value).toBe("Ana wants 3 Nov off.");
});
```

(Prefer the file's own scenario fixture to `createEmptyScenarioUiState`, where one exists.)

`assistant-activity.test.tsx`:

```ts
it("says it is summarising while a long thread is compacted", () => {
  render(<AssistantActivityStatus activity={{ kind: "summarising" }} />);
  expect(screen.getByRole("status").textContent).toContain("Summarising earlier messages…");
});
```

`session-persistence.test.tsx`: add one case in the style of the file's other cases (`seedRow`, `ScriptedAgent`, `session.current!.send`, `agent.clones.at(-1)!.hopInputs`):

```ts
it("sends a long thread as summary + recent turns, and the panel keeps everything (ypo)", async () => {
  // Seed 12 user/assistant pairs of 6,000 characters: over COMPACT_AT_CHARS.
  for (let i = 0; i < 12; i++) {
    await seedRow(threadId, SCENARIO_ID, { messageId: `u${i}`, seq: i * 2, role: "user", content: `old question ${i} ${"q".repeat(6_000)}` });
    await seedRow(threadId, SCENARIO_ID, { messageId: `a${i}`, seq: i * 2 + 1, role: "assistant", content: `old answer ${i}` });
  }
  // Only the summary route is answered here; every other request keeps the harness's own fetch.
  const harnessFetch = globalThis.fetch;
  vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL, init?: RequestInit) =>
    String(url).includes("/api/ai/openrouter/summarize")
      ? new Response(JSON.stringify({ ok: true, summary: "EARLIER-SUMMARY" }))
      : harnessFetch(url, init),
  ));
  // Mount after seeding, exactly as the dirty-history case above does.
  cleanup();
  agent = new ScriptedAgent();
  realAgent.current = agent;
  render(<Host />);
  await waitFor(() => expect(agent.messages.length).toBe(24));
  agent.shape = "answer";
  agent.answer = "ok";
  await act(async () => { await session.current!.send("new question"); });
  await settle();

  const hop = agent.clones.at(-1)!.hopInputs[0]!;
  const sent = JSON.stringify(hop.messages);
  expect(sent).not.toContain("old question 0");
  expect(sent).toContain("old question 8"); // 4 most recent old user turns are kept
  expect(sent).toContain("new question");
  expect(JSON.stringify(hop.context)).toContain("EARLIER-SUMMARY");
  // The panel and the durable history are untouched.
  expect(JSON.stringify(agent.messages)).toContain("old question 0");
  expect(await harness.db.assistantMessages.where("threadId").equals(threadId).count()).toBeGreaterThanOrEqual(25);
  expect(session.current!.summarised).toBe(true);
  vi.unstubAllGlobals();
});
```

Adapt the variable names (`threadId`, `SCENARIO_ID`, `seedRow`, `Host`, `settle`, `realAgent`) to what the file's `beforeEach` defines. The shape above mirrors the existing "normalizes dirty history" case. The cut is computed on the history before the new message. So of the 12 old user turns, the last 4 stay (`old question 8` to `11`).

- [ ] **Step 2: Run them and see them fail**

Run: `cd /home/kenan/work/nursing-sheduler.feat-ypo-history-compact/web && pnpm vitest run lib/ai/assistant/scenario-context.test.ts components/ai/assistant-activity.test.tsx components/ai/session-persistence.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

`scenario-context.ts`: add `earlierSummary?: string | null;` to `BuildContextInput`, and append at the end of `buildAssistantContext`'s array:

```ts
    ...(input.earlierSummary
      ? [
          {
            description:
              "A summary of the earlier part of this conversation. Those older messages are " +
              "not included below; rely on this summary for what was said and decided there.",
            value: input.earlierSummary,
          },
        ]
      : []),
```

`turn-authority.ts`: add to `ProviderHopGuardDeps`:

```ts
  /**
   * bead ypo: messages a stored summary covers. Dropped from every hop's input only;
   * the agent's own list (the panel, persistence) keeps them.
   */
  omitMessageIds?: ReadonlySet<string>;
```

and replace the `authorizedInput` line with:

```ts
        const omit = deps.omitMessageIds;
        const authorizedInput = {
          ...input,
          ...(deps.context ? { context: [...deps.context] } : {}),
          ...(omit && omit.size > 0
            ? { messages: input.messages.filter((message) => !omit.has(message.id)) }
            : {}),
        };
```

`use-assistant-session.ts`:
1. Widen the type to `export type AssistantActivity = { kind: "thinking" } | { kind: "summarising" } | { kind: "tool"; name: string } | null;`.
2. Add `const [summarised, setSummarised] = useState(false);`. In the hydration effect, next to `readThreadMessages`, read the thread row: `void readThread(input.threadId).then((thread) => { if (!cancelled) setSummarised(Boolean(thread?.summary)); });`.
3. In `runSend`, directly after `await persistThreadMessages([userMessage], …)` and before `authorizeLaunchAuthority`:

```ts
      // bead ypo: a long thread is summarised here, in preparation. Every check below
      // still runs after this await, so a Stop or Clear during it refuses the launch.
      setTurnActivity({ kind: "summarising" });
      const compacted = await compactHistory({
        threadId: plan.threadId,
        scenarioId: plan.scenarioId,
        history: plan.history,
        generations: plan,
      });
      if (compacted.compactedNow) setSummarised(true);
      setTurnActivity(THINKING);
```

4. In the `createProviderHopGuard(turnAgent, { … })` deps, pass `earlierSummary: compacted.summary?.text ?? null` into `buildAssistantContext({ … })`, and add `omitMessageIds: omittedMessageIds(plan.history, compacted.summary),`.
5. Add `summarised: boolean;` to the `AssistantSession` interface, and `summarised,` to the returned object.

`assistant-conversation.tsx`: in `AssistantActivityStatus`, compute the label as:

```ts
  const label =
    activity.kind === "tool"
      ? (TOOL_ACTIVITY[activity.name] ?? "Working…")
      : activity.kind === "summarising"
        ? "Summarising earlier messages…"
        : "Thinking…";
```

Add and render the notice, right after `<LifecycleNotice … />` in `AssistantLiveConversation`:

```tsx
/** bead ypo: one quiet line while this thread carries a summary of older messages. */
export function CompactionNotice({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <p className="px-4 pb-2 text-meta text-ink2" role="status" data-testid="assistant-compacted">
      {COMPACTION_NOTICE}
    </p>
  );
}
```

```tsx
      <CompactionNotice show={session.summarised} />
```

`docs/ai-assistant.md`, under "What leaves your browser", add a bullet:

```markdown
- in a long conversation, the older messages once more, so the model can write a short
  summary of them. After that the summary is sent instead of those messages, and the panel
  says "Earlier messages were summarised to keep this conversation going." Your own copy of
  the conversation keeps every message until you clear it.
```

- [ ] **Step 4: Run the assistant suites**

Run: `cd /home/kenan/work/nursing-sheduler.feat-ypo-history-compact/web && pnpm vitest run components/ai lib/ai`
Expected: PASS. The existing `session-persistence` and `session-real-core` cases stay under the budget, so they make no summary request. If one fails on an unexpected fetch, its history is over 60,000 characters: raise that fixture's stub, do not raise the budget.

- [ ] **Step 5: Gate, commit, close**

```bash
cd /home/kenan/work/nursing-sheduler.feat-ypo-history-compact/web && pnpm typecheck && pnpm lint && pnpm format:check
cd .. && git add web docs/ai-assistant.md
git commit -m "feat(assistant): send long threads as summary plus recent turns (ypo)"
bd close nursing-sheduler-ypo
```

## Cross-plan note

`2026-09-27-assistant-attachments.md` (2by.10) adds image and text attachments to user messages. The plan that lands second must make `historyChars` count each attachment as 1,000 characters. It must also make `transcriptForSummary` write `[attached image: <filename>]` or `[attached file: <filename>]` instead of the data. Summarised images are then not resent, which is also the main cost saving.

## Unresolved questions

1. **One budget, or one per model?** I recommend a fixed 60,000 characters for now. Scaling to `CatalogModel.contextLength` needs the catalog on the send path, and every listed tool model has at least 128k tokens.
2. **A "Show what was summarised" link on the notice?** I recommend no (YAGNI). The panel still shows every original message.

## Assumptions

- `generateText` with `openrouter.chat(model)` sends a non-streaming `/chat/completions` request, which OpenRouter answers in the OpenAI shape. Task 3's fixture proves the request side.
- Four recent user turns carry enough verbatim context for Apply follow-ups and open cards. Cards and Previews are host state, not history, so compaction does not affect them.
- Next.js route handlers accept a 120,000-character JSON body without extra config (the 1 MB default limit applies to Server Actions, not route handlers).
