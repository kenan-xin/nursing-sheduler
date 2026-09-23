# AI assistant — Phase-1 activation runbook

This is the release gate for the optional AI assistant, and the record of what each
lane actually proves. It is for whoever has to decide whether a build is safe to
ship, or has to re-run the gate after a change. The user-facing description of the
feature lives in [The AI assistant (Phase 1)](ai-assistant.md).

## The activation contract

**There is no deployment flag to turn the assistant on, and that is deliberate.**
Activation is per browser, opt-in, and requires a credential the user supplies:

```text
fresh profile
  └─ assistantSettings row absent            → enabled=false, apiKey=null
     └─ user switches AI features on         → "Configuring": still no launcher,
        │                                        still no CopilotKit provider mounted
        └─ user supplies key + model
           └─ probe PASSES                     → "Ready": launcher appears
              probe FAILS                     → nothing stored; prior config intact
```

Consequences worth being explicit about, because they are what the gate checks:

- Shipping a build **cannot** enable AI for anyone. Existing users are unaffected by
  a deploy; their stored row is the only thing that decides.
- Until Ready, the CopilotKit provider is **not mounted at all** — not hidden. There
  is therefore no transport carrying the credential headers, and no provider request
  can be made.
- A failed probe is a no-op on storage, so a bad key cannot half-enable the feature.
- Rolling back is `Clear all AI data` per browser, or simply shipping a build without
  the feature; there is no server-side state to unwind.

An operator kill switch (an env flag that hides the Settings card and gates
`/api/copilotkit` for a whole deployment) is **out of settled scope** — not a
deferred follow-up. If a ward needs AI to be impossible rather than optional, that is
a product decision to reopen, not a configuration step.

### The assistant is supported in ONE browser tab

Settled with the user on 2026-08-11 (see the `single-tab-ai-support` decision). The
assistant is supported in **one tab at a time**, and the product does not promise that a
Clear, Disable, key/model replacement or takeover committed in one tab prevents a request
another tab is already starting from stale in-memory state.

What remains strict, and is gated below: **same-tab** Stop, Disable, Remove/Replace key or
model, Clear history and Clear all are hard interruption boundaries; a request whose
transport already began cannot be recalled, and its late chunks, tool results, proposals
and writes stay abortable and quarantined under the existing fences.

The existing read-only, ownership and takeover behaviour across tabs is retained and may
still help, but it is **best-effort defence rather than an AI concurrency guarantee**. The
supported recovery from a conflict is to close the other tab and reload the active one.

**Before configuring a key or running any live journey below, close every other tab of
this app.** The live evidence is single-tab evidence.

### The one deployment constraint

The assistant's runtime keeps active-run state in the Next process's memory, so
Phase 1 supports **exactly one web instance**. A container told otherwise
(`NS_WEB_REPLICAS` > 1) refuses to start rather than silently detaching browser turns
in production. `make verify-deploy` asserts both halves.

## Running the gate

All lanes use the repo-pinned toolchain (`.mise.toml`: Node 24.14.0, Python 3.12.13).
Run them from a clean checkout, serially — several are timing-sensitive and the
browser and Docker lanes contend for the same cores.

```bash
mise install

# 1. Frozen install — the locked CopilotKit package family is itself a contract.
(cd web && mise exec -- pnpm install --frozen-lockfile)

# 2. Web static gates.
(cd web && mise exec -- pnpm typecheck && mise exec -- pnpm lint && mise exec -- pnpm format:check)

# 3. Web unit/integration suite.
(cd web && mise exec -- pnpm test)

# 4. Production build.
(cd web && mise exec -- pnpm build)

# 5. Browser suite (builds and serves a production bundle itself).
(cd web && mise exec -- pnpm test:e2e)

# 6. Backend lint + suite, memory and fakeredis.
mise exec -- ruff check core && mise exec -- ruff format --check core
mise exec -- python -m pytest core/tests -q

# 7. Backend suite against a REAL Redis. Parity is a release gate, not an extra.
docker run -d --name t11-redis -p 6401:6379 redis:8-alpine
NURSE_TEST_REDIS_URL=redis://127.0.0.1:6401/0 mise exec -- python -m pytest core/tests -q
docker rm -f t11-redis

# 8. Assembled Docker gates. On macOS these need GNU coreutils on PATH -- the
#    bounded probes shell out to `timeout`, which macOS does not ship. The gate
#    refuses to start without it rather than reporting probe failures.
#      brew install coreutils
#      export PATH="/opt/homebrew/opt/coreutils/libexec/gnubin:$PATH"
make verify-deploy      # private topology, containment, capability manifest, detachment
make verify-stream      # assembled Browser → Next → FastAPI SSE

# 9. Bounded secret / content scan over the artefacts the run produced.
bash scripts/ai-release-scan.sh
```

## What each lane proves

| Contract | Where it is proved | Why there and not elsewhere |
| --- | --- | --- |
| Locked package family | `lib/ai/runtime/package-family.test.ts` under a frozen install | Records the RESOLVED versions, so a lockfile float is a failure rather than a silent upgrade |
| Runtime containment (telemetry off, `no-store`, no cookie, launch instance id, no server-side thread history) | `make verify-deploy` | Only a deployed container shows what the real Next server actually sends |
| Restart / instance-mismatch detachment | `lib/ai/runtime/*.test.ts` **and** `make verify-deploy` | The unit suite pins the branch; the deploy gate proves the deployed runtime answers a foreign-instance stop as *detached*, and an unknown thread as an idempotent no-op |
| One web instance | `make verify-deploy` | Asserts both the running topology and that a multi-instance container refuses to boot |
| Off by default, from a genuinely fresh profile | `e2e/ai-assistant-activation.spec.ts` | Only a real first visit can show that nothing is mounted, nothing stored, and no request made |
| Enable → probe → Ready, and every failure lane | `e2e/ai-assistant-activation.spec.ts`, `components/settings/ai-assistant-card.test.tsx` | The browser drives the real Settings journey; the setup routes are answered locally so no live credential is needed |
| Credential containment across the whole browser | `e2e/ai-assistant-activation.spec.ts` | Cookies, both web storages, the DOM and the request log only exist in a browser |
| Clear all → detach → reload → late callback quarantined | `e2e/ai-assistant-activation.spec.ts` (assembled) plus `lib/ai/assistant/clear-repo.test.ts` | The fence is durable precisely so it survives a reload; proving that needs two real page lifetimes over one IndexedDB |
| Single-writer authority across tabs (scheduling; **best-effort** for AI) | `e2e/scenario-ownership.spec.ts`, `e2e/ai-assistant-activation.spec.ts` | Two pages in ONE browser context — two contexts get separate storage and could never contend. These prove the scenario lease/read-only/takeover behaviour; they are **not** a cross-tab AI provider-ordering gate, which the single-tab decision removed |
| Atomic Apply, per-table write faults, receipts, Undo | `lib/repository/assistant-apply.test.ts`, `e2e/assistant-proposal-apply.spec.ts` | Fault injection at each table write is a unit concern; that the transaction is genuinely atomic in Chromium's IndexedDB is not |
| Trusted / stale semantic basis, closed outcomes | `lib/ai/diagnostic/*.test.ts`, `core/tests/test_server_*` | TypeScript/Python canonical agreement has to be checked on both sides |
| Diagnostic priority and the ordinary reserve | `core/tests/test_server_priority_queue.py` across memory, fakeredis **and** real Redis; purpose round-trip **and** the seven-diagnostic reserve lane in `make verify-deploy` | The parity suite proves the arithmetic at the store and TestClient level; the deploy gate proves the same boundary through a real ASGI server, real HTTP and the private Compose Redis (see below) |
| Capability registry / anchor drift | `lib/capability/*.test.ts`, `e2e/capability-anchors.spec.ts`, `make verify-deploy` | The deploy gate proves the DEPLOYED bundle carries the generated manifest hash, and that a wrong hash is absent |
| AI independence | `lib/ai/independence.test.ts` (source-level), plus the AI-off lanes in the browser suite | A functional test only samples independence; an import-graph assertion guarantees it |
| Phase-2 absence | `lib/ai/phase-2-absence.test.ts` | Enumerates every model-visible tool and every proposal operation, so a roster-repair surface cannot appear without a reviewed edit |
| No credential or content in logs / artefacts | `scripts/ai-release-scan.sh` | Scans from the outside — bundle, e2e artefacts, repo tree, container logs |

## Nurse-facing wording the gate holds to

These are the claims most likely to drift in a copy edit, so each one is pinned by a
named test rather than by review habit:

| The claim that must not appear | Where the honest wording is pinned |
| --- | --- |
| Causal proof — “the run failed because X” | `lib/ai/diagnostic/diagnostic-explanations.test.ts` (`does not prove`, `proves only`, and a `CAUSE_UNAVAILABLE` baseline on every summary); `components/ai/assistant-diagnostic.test.tsx` (`not reported causes`) |
| Guaranteed feasibility or availability | `components/settings/ai-assistant-card.tsx` copy asserted by its card test: *“A successful test does not guarantee OpenRouter stays available”* |
| Secure or encrypted browser key storage | The card and `lib/capability/help-content.ts` both say **not encrypted**, and `lib/ai/assistant/records.ts` states the invariant at the type |
| A fixed downstream recipient | The card's own description names OpenRouter *plus the chosen model* as the path, with routing that may vary |
| Implemented roster repair | `lib/ai/phase-2-absence.test.ts`; `components/ai/use-help-tools.test.tsx` drives a `repair-the-roster` capability id and asserts it fails closed |
| “Already cancelled” before a terminal acknowledgement | `components/ai/assistant-interruption.test.tsx` asserts *Stopping. Waiting…* during settling and the 15-second detach wording afterwards |

## The one lane this gate cannot run

**Live-provider journeys are an external release blocker.** Everything above stops at
the app's own boundary. No test supplies a real credential; the one browser lane that
reaches *Ready* answers both same-origin setup routes (`/api/ai/openrouter/test` and
`/api/ai/openrouter/models`) in the page, so the server never fetches the catalog
either and nothing in the suite contacts `openrouter.ai`. (With AI off the card does
not query the catalog at all — an off-by-default feature must not reach a third party
on an ordinary Settings visit.)

That is a deliberate property of the suite: a release gate that needed a funded
provider account would not be reproducible. But it means the following have **not**
been observed end to end and must be signed off separately, by a human with a real
key, before general release:

1. A real key + tested model passing the probe against live OpenRouter.
2. One complete streamed turn: setup question → grounded answer.
3. A model-prepared change reaching host Preview, being confirmed and applied.
4. A bounded diagnostic search driven by a live model against a real failed run.
5. Stop / Disable / Clear during a live stream, observing real settlement.

### Port note

Use an explicit IPv4 host and a dedicated port, as `docker/.env` now does
(`PUBLIC_ORIGIN=http://127.0.0.1:3020`, `WEB_PORT=3020`). On macOS `localhost`
resolves to `::1` first, and an unrelated `next-server` from another worktree holding
the IPv6 wildcard on `:3000` will win `localhost:3000` while Docker's
`127.0.0.1:3000` serves this stack — two different apps on one browser origin,
sharing one IndexedDB. The symptom is subtle: the app looks almost right, but the
assistant is missing and Dexie logs `Creating missing table` for a schema that is not
ours. A dedicated port removes the ambiguity and gives the stack a clean origin.

```bash
make up                      # start (reads docker/.env)
make down                    # stop, keeping the redis volume
make down && docker volume rm docker_redis-data   # stop and discard job state
```

### How to hand over a key safely

**The key never needs to reach a shell, a file, an environment variable, this
repository, or a chat message.** All five journeys are browser journeys, so the whole
handover is:

0. **Close every other tab of this app first** — the assistant is supported in one tab,
   and the journeys below are single-tab journeys.
1. The key holder opens the running app **on their own machine** and goes to
   **Settings → AI assistant**.
2. They paste the key into the masked field and press **Save and test**. The app shows
   only `••••••••` plus the last four characters from then on.
3. They work through the five journeys and report **outcomes only** — pass/fail and
   what the app said.
4. When finished: **Clear all AI data** in the same card, then revoke the key at
   OpenRouter.

Use a throwaway key with a low spend cap, on a scenario containing no real staff data.
Record the outcome in the evidence table below. Do not paste the key into this file,
an artefact, an issue, or a message.

If the key needs a standalone sanity check *before* step 1, this is the only command
to run — it reads the key without echoing it, keeps it out of shell history, prints a
bare HTTP status code and nothing else, and unsets it afterwards:

```bash
read -rs OPENROUTER_KEY && \
  curl -sS -o /dev/null -w '%{http_code}\n' \
    -H "Authorization: Bearer $OPENROUTER_KEY" \
    https://openrouter.ai/api/v1/models; \
  unset OPENROUTER_KEY
```

`200` means the key is accepted. Anything else means the key, the account, or the
network is the problem — and no part of the key has been written anywhere.

## Evidence — 2026-08-07

Host: macOS (darwin 25.5.0, arm64). Toolchain from `.mise.toml`: Node 24.14.0,
Python 3.12.13, pnpm 11.17.0. Base commit `94c0402` plus the T11 changes.

| Lane | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | clean, no lockfile drift |
| `pnpm typecheck` / `pnpm lint` / `pnpm format:check` | pass |
| `pnpm test` (Vitest) | 4,935 passed, 72 skipped, 257 files |
| `pnpm build` | pass |
| `pnpm test:e2e` (Playwright, chromium + coarse-pointer lane) | 570 passed |
| `ruff check core` / `ruff format --check core` | pass |
| `pytest core/tests` (memory + fakeredis) | 933 passed, 73 skipped |
| `pytest core/tests` with real Redis (`redis:8-alpine`) | 1,002 passed, 4 skipped |
| `make verify-deploy` | 47 passed, 0 failed |
| Local stack for manual journeys | `http://127.0.0.1:3020` (see the port note below) |
| `make verify-stream` | 34 passed, 0 failed |
| `scripts/ai-release-scan.sh` | 7 passed, 0 failed, 0 skipped — including the container-log lane, run against a stack that had just served real credentialed requests |
| Live-provider journey 1 (probe) | **pass** |
| Live-provider journey 5 (Clear all) | **pass** |
| Live-provider journeys 2–4, and Stop/Disable | **BLOCKED — see “The tool-execution gap” below** |

## The tool-execution gap (found by the live lane, 2026-08-08)

The first live turn exposed a defect no gate could see, because no gate had ever run
a real provider turn. Two halves:

1. **Tools never reached the provider.** `copilotkit.runAgent({ agent })` is the
   library path, and part of what it does is attach
   `tools: buildFrontendTools(agent.agentId)`. The app deliberately does not use that
   path — `useAssistantSession` owns the launch so readiness, the writer lease, the
   turn epoch, the durable `preparing` row and the final no-await authority check are
   all settled first. Nothing then injected the tools, so every run went out with
   `tools: []` and the model answered *“I don't have access to your app.”*
   **Fixed** in this pass: the session asks the core for the same list
   (`components/ai/frontend-tools.ts`), pinned by `components/ai/frontend-tools.test.ts`.
   Verified live: a run now carries all eight tools.

2. **Nothing executed the tools or ran the follow-up.** **Fixed** in T11-F1 — see
   “How the loop is closed” below. The same library
   method also calls `processAgentResult(...)`, which executes the frontend tool
   handlers and then recurses into a follow-up run (bounded by `MAX_FOLLOW_UP_DEPTH`)
   so the model can answer *from* the tool result. The app's path implements neither.
   Driving the deployed runtime directly shows the whole shape:

   ```text
   RUN_STARTED → TOOL_CALL_START(get_schedule_overview) → TOOL_CALL_ARGS →
   TOOL_CALL_END → RUN_FINISHED
   ```

   The turn settles `completed` with **no assistant message at all** — the user sees
   their own question and nothing else.

While that was open, every Phase-1 capability that depends on a tool was inert:
reading the schedule, grounded help, host navigation, preparing a proposal, and
bounded diagnostics.

### How the loop is closed

The app still owns the launch — readiness, the writer lease, the turn epoch, the
durable `preparing` row and the final synchronous identity check all happen before a
byte leaves. What changed is what happens *after* that gate:

| Concern | Before | Now |
| --- | --- | --- |
| Tool execution + follow-up | Nothing did it | `copilotkit.runAgent` — the public core entry point. CopilotKit stays the one implementation of tool execution, tool-result insertion, abort propagation, framework yielding and bounded follow-ups |
| Guarding each provider hop | Only the first hop was gated | A public AG-UI middleware (`agent.use`) at the transport boundary. Every hop — initial and follow-up — rereads the durable writer claim, then runs the synchronous identity check with no await before delegating. A refusal subscribes to nothing, so no request is made |
| The approved snapshot | A run parameter, so it described the first hop only | Registered in CopilotKit's agent-scoped context store for the turn and removed in `finally`, so follow-ups see the exact document the gate approved |
| Persistence boundaries | A per-run subscriber, blind to follow-ups | `agent.subscribe` for the whole turn, so the answer a follow-up produces is persisted like any other |
| Tool handler checks | The turn epoch alone | One shared guard over abort, scenario/thread/turn/run identity, turn epoch, **lease epoch** and **document revision** — the last two are what an epoch check could never see |

No private CopilotKit API is called, no result processor is copied, and the
high-level `CopilotChat` submission lifecycle is not used.

Three further properties came out of the first cold review of this fix:

- **Authority is a token, not a slot.** A callback captures the immutable identity of
  the turn it began under (agent, thread, scenario, turn, run, epoch) and every later
  check demands that same token by identity. Without it, a suspended callback from a
  detached turn A could resume after turn B took the binding and act under B's
  authority. Every teardown — the binding, the active run handle, the store's active
  turn — is compare-and-clear, so A's late `finally` cannot erase B's Stop target or
  blank its running state.
- **A failed run is never `completed`.** `copilotkit.runAgent` resolves even when the
  agent run fails — the locked core catches the error and returns an empty result — so
  a `catch` alone marked dead transports as answered. The public `onRunFailed`
  subscriber callback is latched per turn, and settlement precedence is: authority
  refusal first, then `run_failed`, and `completed` only when neither happened.
- **Long-running tools are fenced at their effects, not around them.** The captured
  token and abort signal reach inside the diagnostic search and the navigation action,
  and authority is rechecked immediately before every solver POST, durable write, card
  publication, route push and reveal/focus. Withholding only the returned sentence
  would leave the user moved, focused, and looking at a card for a turn they stopped.

`components/ai/tool-loop.test.ts` proves it against a real `CopilotKitCore` and a real
`AbstractAgent` whose transport is scripted to reproduce the exact event sequence the
deployed runtime emitted: the handler runs once, its result is inserted, a bounded
follow-up happens, and an assistant answer is produced. It then forces a takeover, a
lost lease, a revision change, Stop, and an epoch move at each boundary — before the
first hop and during the tool — and asserts zero requests and zero late answers, with
a non-vacuity case proving the same harness completes both hops when authority holds.

The deploy gate grew four assertions in this pass: a foreign-instance stop detaches,
an unknown-thread stop stays an idempotent no-op (the sensitivity check for the
first), the job-purpose enum round-trips across the deployed HTTP boundary with an
unrecognised purpose failing closed, and the seven-diagnostic reserve lane below.

### The assembled reserve lane

`docker/reserve_gate_probe.py` proves the ordinary reserve over real HTTP against the
private Compose Redis, deterministically:

1. Seven diagnostics are admitted — every slot a diagnostic is entitled to under the
   shipped defaults (eight pending, one reserved) — each at the queue position it
   should hold.
2. The eighth diagnostic is refused **429 `diagnostic_capacity_reserved`**, not as a
   full queue, and the refusal body mentions nothing about the document it refused.
3. An ordinary job is still admitted into the reserved slot, and takes **position 1** —
   ahead of all seven queued diagnostics.
4. A further ordinary job is refused **429 `job_capacity_exceeded`** — the *other*
   code. This is the sensitivity check: without it, step 2 would pass equally against
   a queue that was merely full, which would prove nothing about the reserve.
5. Every job it created is deleted, each deletion confirmed by a 404, and its Redis
   namespace asserted empty.

It cannot run against the live gate backend, whose worker would claim the queue out
from under the assertions. So it stands up its own app with `start_background=False` —
no worker, no maintenance pass, nothing solved and nothing timed — in its own Redis
namespace on its own loopback port. The outcome does not depend on how fast anything
is, and the live backend's keys are never read or written.

### Note on suite timing

Three assertions in the web suite were failing only under the fully parallel run and
passing in isolation. They were genuine wait defects, not product faults, and were
fixed at the assertion rather than by raising any global budget:

- `assistant-proposal.test.tsx` read a receipt attribute once, immediately after
  `findByTestId`, while the value it asserts comes from a *second* repository read
  that lands a render later. It now waits for the value.
- `assistant-interruption.test.tsx` sampled a transient `settling` phase under the
  1s `waitFor` default, though reaching it requires a Dexie read plus one write per
  unsettled turn. That one assertion has an explicit 5s budget; the 15-second
  product settlement window it goes on to assert is unchanged.
- `package-family.test.ts` dynamically imports the whole `@copilotkit/runtime/v2`
  entrypoint — the heaviest module load in the suite — under the 5s default. That
  one test has an explicit budget.
