# Lane 04: v1 Python AI package compared with the v2 assistant

Date: 2026-09-25. v1 = `/home/kenan/work/nurse-scheduling` branch `dev` at `d41a6c5`. Base pin = `d63519b` (2026-07-20). v2 = this worktree (core matches `develop`).

Scope: `core/nurse_scheduling/ai/**`, `core/nurse_scheduling/ai_serve.py`, their tests (`core/tests/test_ai_*.py`, `core/tests/ai_test_helper.py`, `core/tests/ai_eval/**`), `docker/e2b/**`, `scripts/start_ai_backend.sh`, and the AI parts of the compose files.

## 1. Summary

- The whole v1 AI package is new after the base pin. At `d63519b` the directory `core/nurse_scheduling/ai/` did not exist. `git diff --stat d63519b dev` shows 42 files and 9,250 added lines in the package, plus 149 test files and 15,892 added test lines.
- 144 commits touch the package (`99a3913` 2026-08-12 to `63dfc54` 2026-09-23). About 180 distinct commits touch the package, its tests and its E2B build files together. The churn is high: about 25 commits per week.
- v1 architecture: a separate FastAPI service (`nurse_scheduling.ai_serve:app`, port 8001, one worker). It holds sessions in memory and streams SSE events. It calls one operator-configured OpenAI-compatible provider. It runs every tool call in a disposable E2B Cloud sandbox. It logs chat text to PostgreSQL for 30 days. It calls the normal optimizer HTTP API as a background tool.
- v2 architecture: the assistant is client-side and opt-in (BYO OpenRouter key per browser, CopilotKit runtime in the Next.js server, no server storage). No v2 Python code uses an LLM. v2 core has no `ai/` directory.
- Headline risk 1: the package does not import cleanly into v2 core. It imports three v1 modules that v2 core does not have: `nurse_scheduling/sentry.py`, `nurse_scheduling/server/auth.py`, `nurse_scheduling/frontend_validation.py`.
- Headline risk 2: `ai/schema.py:34-35` reads two files from the v1 repository root, `docs/content/user-guide/**.md` and `web-frontend/src/utils/taiwanHolidays.ts`. Neither path exists in v2. Every sandbox turn (`sandbox_agent.py:439-443`) and `test_ai_schema.py:216-221` will fail.
- Headline risk 3: v1 behavior conflicts with v2 product decisions. v1 uses an operator key, keeps chat text on the server, and executes model-written Bash. `docs/ai-assistant.md` promises that "The server side keeps none of it".
- Recommendation: exclude the package from v2 core and record the exclusion in the T19 manifest. Port individual ideas (optimizer anonymization, attachment inspection, evaluation cases) to the v2 TypeScript assistant only when a product decision asks for them. See section 4.

## 2. v1 architecture and capabilities

### 2.1 Components

| Part | v1 file | What it does |
| --- | --- | --- |
| HTTP service | `ai/app.py` (1,349 lines), `ai_serve.py` | FastAPI app. Routes: `GET /health`, `/ready`, `/capabilities`; `POST /sessions`; `GET /sessions/{id}`; `GET /sessions/{id}/events` (SSE); `POST /sessions/{id}/messages`; `POST /sessions/{id}/messages/queue`; `POST /sessions/{id}/stop`; `PUT /sessions/{id}/schedule`; `POST /sessions/{id}/proposal/approve`; `POST /sessions/{id}/proposal/reject`; `GET /sessions/{id}/optimizations/{job_id}/xlsx` (`app.py:887-1335`). In-memory `SessionStore` (`app.py:274-629`). Owner cookie per session. Bearer auth through `server.auth` (`app.py:44`). |
| Settings | `ai/config.py:105-243` | About 45 environment variables. `AI_PROVIDER_API_KEY`, `AI_PROVIDER_BASE_URL`, `AI_PROVIDER_MODEL` are required. `AI_SANDBOX_BACKEND` must be `e2b` (the value `none` raises at start, `config.py:193-194`). |
| LLM provider | `ai/provider.py` `OpenAiCompatibleProvider` (`233-380`) | One operator-held key. OpenAI-compatible `/chat/completions` streaming with text, reasoning deltas, tool-call reconstruction, image parts, retries, redacted error logs. Any OpenAI-compatible endpoint works (default model name `local-model`). |
| Agent loop | `ai/agent.py` `run_tool_agent` (`117-223`) | Streams provider rounds, runs tool batches (read-only batches in parallel, `633b063`), and caps rounds and calls (200 rounds, 400 calls, `e02d366`). |
| Sandbox | `ai/sandbox/e2b.py`, `e2b_cleanup.py`, `reap.py`, `base.py`, `fake.py`, `factory.py` | One E2B Cloud sandbox per user message, created on first tool use (`8b59daa`). Pause and resume, retries, leaked-sandbox reconciliation, a standalone reaper (`python -m nurse_scheduling.ai.sandbox.reap`), Sentry reports for stray sandboxes. Template built from `docker/e2b/e2b.Dockerfile` and published at server start (`6f066a6`). |
| Tools for the model | `ai/sandbox_tools.py`, `ai/pi/*` (MIT, port of the Pi coding agent) | `bash`, `read`, `edit`, `write` inside `/workspace`, plus the server-side `optimizer` tool. |
| Proposal gate | `ai/candidate.py`, `ai/validation.py`, `ai/diff.py` | The final `/workspace/schedule.yaml` becomes a proposal only after trusted server validation (`frontend_validation.load_frontend_data`) and a structural diff. The user approves or rejects it. Approval revalidates against the base revision (`9227275`). |
| Guidance | `ai/prompts/sandbox-system.md`, `ai/references/*.md`, `ai/schema.py` | System prompt plus schema references, user-guide pages and the Taiwan holiday source, copied into `/reference/` in the sandbox. |
| Background turns | `ai/background.py` | Runs a turn without a live request, for example when an optimizer run ends. Event broker with replay, history trimming for the prompt. |
| Optimizer tool | `ai/optimizer.py`, `ai/optimizer_privacy.py` | Actions `start`, `status`, `finish_now` (`optimizer.py:643-670`). Calls `POST /optimize`, `GET /optimize/{id}`, `/events`, `/finish-now`, `/cancel`, `DELETE /optimize/{id}` and `links.schedule` (`optimizer.py:110-221`). Replaces person IDs and removes descriptions before submission, and restores IDs in the result workbook. Max 50 runs per session. Requires HTTPS for a credentialed remote optimizer (`4059993`). |
| Persistence | `ai/history.py`, `ai/migrations/001_chat_history.sql`, `002_arbitrary_attachments.sql` | PostgreSQL via `psycopg`. Tables `chat_sessions`, `chat_turns` store the user message, the assistant message, model, status, token usage. Hourly prune after 30 days. Write-only: nothing reads it back for the user. |
| Attachment helpers | `ai/attachment_tools/inspect_pdf.py`, `inspect_xlsx.py` | Scripts that run inside the sandbox image to inspect PDF and XLSX files. |

### 2.2 Deployment in v1

`docker/compose.backend.yml` in v1 adds these services for the AI: `ai` (same image as `api`, command `uvicorn nurse_scheduling.ai_serve:app --port 8001 --workers 1`), `postgres` (`postgres:18-alpine`, volume `postgres-ai-data`), `pgadmin` (profile inspector), and an nginx route `location /ai/ { proxy_pass http://ai:8001/; }` (`docker/nginx.backend.conf:22-26`). The `ai` service needs `E2B_API_KEY` and a provider key. The frontend page is `web-frontend/src/app/experimental-ai/page.tsx` (2,360 lines, out of this lane). The hosted beta is gated by an API key (`docs/content/user-guide/experimental-ai.md`).

### 2.3 User-visible capabilities, v1 compared with v2

| Capability | v1 (server agent) | v2 (client assistant, `docs/ai-assistant.md`) |
| --- | --- | --- |
| Who pays for the model | Operator key on the server | User's own OpenRouter key, per browser |
| Model choice | One model fixed by the operator | User picks any OpenRouter model that passes a tool-call test |
| Answer questions about the schedule | Yes, the model reads the YAML with `read`/`bash` | Yes, `get_schedule_overview`, `get_schedule_section` |
| Answer app-usage questions | Yes, from user-guide Markdown in the sandbox (`114fe92`) | Yes, `list_app_capabilities`, `explain_app_capability`, `open_app_screen` (navigates) |
| Propose a schedule change | Yes, any YAML edit, one diff, approve or reject | Yes, a fixed op list through `prepare_scenario_change` with Preview and cascades, user presses Apply |
| Arbitrary edits | Yes, the model can rewrite any part of the YAML | No, one operation family at a time (agent-native plan) |
| Clarify ambiguous targets | Prompt rules (`13557c5`, `ae8efda`) | Playbook and `offer_choices` cards |
| Run the optimizer | Yes, the model starts runs itself, up to 50 per chat, in the background | Yes, `request_optimize_run` card, the run starts only on the user's Run click |
| Read the optimizer result | Yes, workbook copied into the sandbox, download link in chat | Yes, `get_optimize_result`, `get_roster` |
| Streamed optimizer progress in chat | Yes (`43e2554`) | The run is an ordinary Optimise-screen run with its own progress |
| Infeasibility repair | No specific feature | Yes, `suggest_feasibility_options`, `test_feasibility_candidates` on copies, four-step cover ladder |
| Roster swaps and borrowed cover | No | Yes, `find_swap_partners`, `prepare_roster_swap`, `prepare_borrowed_cover` |
| Setup guidance for an empty scenario | Partly, by prompt | Yes, `get_setup_progress` |
| File attachments (any type, PDF, XLSX, images) | Yes, up to 8 files, 5 MB each (`11a1b84`) | No attachment support found in `web/components/ai` or `web/lib/ai` |
| Show reasoning and tool activity | Yes, collapsible rows (`319dd3d`) | Proposal reasoning is shown on the card, no raw tool log |
| Queue a message while a turn runs (steering) | Yes (`53a1b2c`) | No (UNVERIFIED: no match for queue or steer in `assistant-panel.tsx`) |
| Chat survives page navigation | Yes, retained on the server session (`d949f46`) | Yes, history kept in the browser per schedule |
| Chat export | Yes, `chatExport.ts` in the v1 frontend | No match found in v2 |
| Anonymization before optimizer submission | Yes (`8755080`) | Not relevant: the user's own Optimize path runs in the user's session |
| Server-side storage of chat text | Yes, PostgreSQL, 30 days | None, by design |

## 3. Change table

All rows share one v2 status: absent. v2 core has no `ai/` directory and no `ai_serve.py`. "Conflict notes" name what blocks a verbatim port.

| ID | v1 commits | Files | What it does | v2 status | Conflict notes vs v2 | Proposed action | Effort | Risk |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| AI-01 | `99a3913` `0a7331b` `9710927` `d72fb70` `9802cb0` `612da8a` | `ai/__init__.py`, `ai/app.py`, `ai/config.py`, `ai/provider.py`, `ai_serve.py`, `scripts/start_ai_backend.sh`, `tests/test_ai_basic.py` | Experimental chat service: sessions, streaming chat, images, text, PDF and XLSX attachments, correlated provider errors | absent | v2 has its own BYO-key chat in Next.js (`web/lib/ai/runtime/*`). Two chat stacks for one product | skip (NEEDS DECISION D1) | L | M |
| AI-02 | `dfa2cdf` `2c01609` `51977b0` `c6d88c1` `3982110` `c7cc1a2` `2ade8f2` `319dd3d` `9f56b85` `bfedd9c` `2be5c33` `628229c` `f7a6026` `f05c34a` | `ai/agent.py`, `ai/diff.py`, `ai/validation.py`, `ai/schema.py`, `ai/app.py`, `tests/test_ai_agent.py`, `tests/test_ai_diff.py`, `tests/test_ai_validation.py`, `tests/ai_test_helper.py` | Tool loop, streamed tool calls, single-file YAML editor, validated proposal with structural diff, reasoning and tool activity events | absent | `validation.py:27` imports `..frontend_validation` (not in v2 core). v2 proposals go through `prepare_scenario_change` Preview with cascades, a different contract | skip | L | M |
| AI-03 | `d4535d8` `a923b48` `7c6e94a` `28998df` `8fd29dc` `22c494a` `ed63ad2` `eb05b84` `d22fe08` `2c60c64` `89c899f` `c65aa58` `23a6884` `4fe8d5a` `b7611e5` `f3a97f2` `7a4d4b5` `6f066a6` `083f2ec` `7e4a17f` | `ai/sandbox/*` (`__init__`, `base`, `e2b`, `e2b_cleanup`, `factory`, `fake`, `reap`), `docker/e2b/*`, `tests/test_ai_sandbox*.py` | Disposable E2B Cloud sandbox: pause and resume, retries, leak reconciliation, standalone reaper, template publish at server start | absent | Needs the `e2b==2.46.0` package, an E2B account and key, and `..sentry` / `...sentry` (`reap.py:26`), which v2 core lacks. Executes model-written Bash on a third-party cloud | skip | L | H |
| AI-04 | `f51e9ec` `8a0bd47` `2bb9309` `6d2ff42` `dbdcf47` `7f224dc` `0d5a255` `448bb5a` `188546b` `051ec85` `a8407da` `633b063` `cb04efa` `62a0799` `bf273a6` `e02d366` `f76f744` `8b59daa` `6cd5535` | `ai/sandbox_agent.py`, `ai/sandbox_tools.py`, `ai/candidate.py`, `ai/pi/*` (`LICENSE`, `__init__`, `bash`, `edit`, `read`, `write`), tests `test_ai_sandbox_agent.py`, `test_ai_sandbox_tools.py`, `test_ai_candidate.py`, `test_ai_pi_bash.py`, `test_ai_pi_edit.py`, `test_ai_pi_read.py`, `test_ai_pi_write.py` | Bash-only sandbox agent with ported Pi `bash`/`read`/`edit`/`write` tools, atomic turn commit, retained proposal decisions, bounded tool work | absent | Depends on AI-03. `pi/` carries a separate MIT license. v2 tools are typed, per-operation, and run in the browser | skip | L | H |
| AI-05 | `a2f8cb3` `baf8dcd` `4d52d62` `7a43a08` `ad9ea76` `006232d` `ad0b413` `9732fd8` `af7d040` `13557c5` `0ed2012` `4e67dc0` `114fe92` `0b96ff8` `42c588d` `7c920a6` `54e1dbc` `29b3d4c` `b8354b3` | `ai/prompts/sandbox-system.md`, `ai/references/schema-*.md`, `ai/schema.py`, `ai/schedule_context.py`, `tests/test_ai_schema.py`, `tests/test_ai_schedule_context.py` | Agent guidance: schema references, clarification rules, Taiwan holiday renewal, UI guidance from user-guide pages, trusted and untrusted input split | absent | `schema.py:34-35` reads `docs/content/user-guide` and `web-frontend/src/utils/taiwanHolidays.ts` from the v1 repo root. Neither exists in v2. The v2 frontend has no `taiwanHolidays` file | skip. Optional: mine `schema-*.md` and the clarification rules for the v2 playbook (`web/lib/ai/assistant/playbook.ts`) | S (mining) | L |
| AI-06 | `03d2e81` `874f4f7` `3999dd9` `d359b70` `f4ec463` `7c5849e` | `ai/provider.py`, `tests/test_ai_provider.py` | Provider retries, retry reporting, bounded error logs, skip empty stream chunks, tool images sent through user messages | absent | v2 uses the CopilotKit runtime and OpenRouter (`web/lib/ai/runtime/openrouter-agent.ts`) | skip | S | L |
| AI-07 | `e5e3686` `3de3609` `7539036` `ac6a309` `110fcc2` `9227275` `1d46068` `f18af03` `b3a0223` `edbf8af` `76aae25` `7c365f3` `cc73a5b` | `ai/app.py`, `ai/config.py`, `tests/test_ai_basic.py` | Bearer auth with identified keys, cross-site session cookies (`SameSite=None`), stale-turn discard, revalidate before approval, request logging with a question preview, reliable stop | absent | Imports `..server.auth` (`app.py:44`, `config.py:25`). v2 core has no `server/auth.py`; the auth lane owns that module. v2 core is private behind the Next.js BFF, so cross-site cookies have no use | skip | M | M |
| AI-08 | `b20aa81` `11a1b84` (migration 002) | `ai/history.py`, `ai/migrations/001_chat_history.sql`, `ai/migrations/002_arbitrary_attachments.sql`, `tests/test_ai_history.py` | Write-only PostgreSQL log of every user message and answer, 30-day retention, hourly prune | absent | Contradicts `docs/ai-assistant.md` ("The server side keeps none of it"). Adds `psycopg[binary]` and a Postgres service | skip | M | H (privacy) |
| AI-09 | `53a1b2c` `af2db7f` `a23e862` `ef54f6e` | `ai/app.py`, `ai/agent.py`, `ai/config.py`, `tests/test_ai_agent.py`, `tests/test_ai_basic.py` | Queue messages as in-turn steering while the model works | absent | v2 CopilotKit panel has no steering queue (UNVERIFIED in the client) | skip. Feature gap candidate for the v2 panel (D4) | M | L |
| AI-10 | `d949f46` `2f95388` `28f69df` `401ca82` `bb85d03` `362b729` `16e9646` `fba432b` `f957bc9` `3ad84d2` `aba6060` `4add8db` `58fcc64` `07a6587` `c809e0b` | `ai/app.py`, `ai/background.py`, `ai/config.py`, `tests/test_ai_basic.py` | Retain chats on the server across navigation, session byte budget, prompt history cap, warn when older messages drop | absent | v2 keeps history in the browser per schedule. The "prompt drops older messages" warning is a possible v2 gap (UNVERIFIED) | skip | M | L |
| AI-11 | `11a1b84` `9967b7d` | `ai/attachment_tools/*`, `ai/pi/mime.py`, `ai/pi/image_process.py`, `ai/pi/read.py`, `ai/sandbox_tools.py`, `ai/migrations/002_arbitrary_attachments.sql`, `tests/test_ai_attachment_tools.py`, `tests/test_ai_pi_image_process.py`, `tests/test_ai_eval_attachment_fixtures.py`, `tests/ai_eval/attachment_fixtures.py` | Accept any file type, inspect PDF, XLSX and images in the sandbox, bound image decoding | absent | v2 has no attachments. A browser-side version needs no sandbox for text, images, and XLSX (the model can receive images and extracted text) | skip. Feature gap candidate (D4) | M | M |
| AI-12 | `fd86e5e` `52e9024` `c981030` `8755080` `1889841` `97c83e8` `5292b66` `767a10d` `4a07846` `8e06867` `5fb299b` `4059993` `ae3e0df` `3e12c15` `ee76dce` `33ba169` `43e2554` `84db6fb` `f1126b1` `72567e7` | `ai/optimizer.py`, `ai/optimizer_privacy.py`, `ai/background.py`, `ai/sandbox_agent.py`, `ai/config.py`, `ai/prompts/sandbox-system.md`, `tests/test_ai_optimizer.py`, `tests/test_ai_optimizer_privacy.py` | Background optimizer tool: the model starts up to 50 runs, sees progress, gets an anonymized-then-restored workbook, and wakes in a new turn | absent | The HTTP contract matches v2 core: v2 has `POST /optimize`, `/events`, `/finish-now`, `/cancel`, `DELETE /optimize/{id}` (`server/api/optimize.py:113-357`) and `links.schedule` (`server/api/schemas.py:131`). The product rule conflicts: v2 starts a run only on the user's Run click | skip. v2 already covers the user-confirmed version (`request_optimize_run`) | L | M |
| AI-13 | `63dfc54` | `ai/validation.py` | Enforce YAML bounds by parser structure | absent | Same commit changes `frontend_validation.py` and the loader. The input-validation lane owns the non-AI part | skip in this lane. Adopt the loader part in the validation lane | S | L |
| AI-14 | `f0aaa85` `6ce6ed7` `c97b5ce` `97a9669` `0de94fa` `a7b7fb7` `21e5a02` `07116bc` `40203e3` `dff33ab` `9075f90` `4a6a099` `43cf1e2` `86bdc92` `5ff10b1` `fdd21d2` `9a84055` `9cd18dc` `75034ab` `e590f07` `cdbdb36` `187076a` `b1d852a` `2f2b248` `ac59c58` `98d92b7` `b3cd9dc` `3cd2965` `e3f5748` `7ec5c55` `51e567f` `ae8efda` `943e15a` `04b97a2` | `tests/ai_eval/**` (README, `__init__`, `grading.py`, `runner.py`, `provider_preflight.py`, `read_batch_benchmark.py`, `attachment_fixtures.py`, 3 fixtures, 109 case JSON files), `tests/test_ai_eval_grading.py`, `tests/test_ai_eval_runner.py`, `tests/test_ai_provider_preflight.py`, `tests/test_ai_read_batch_benchmark.py` | Live-model evaluation harness with graded multi-turn cases (summary, reading, edits, structure, preferences, export, refusal, multi-turn, proposal lifecycle, holdouts, app UI, attachments) | absent | The runner drives the v1 sandbox agent only. The case JSON grades v1 YAML diffs, not v2 op payloads | skip the code. Optional: reuse case prompts as a v2 eval corpus (D5) | S (corpus), L (harness) | L |
| AI-15 | `3e1a59c` | `core/requirements.txt`, `core/requirements-optional.txt` (outside `ai/`, listed because the AI needs it) | Adds `psycopg[binary]==3.3.5`, `e2b==2.46.0`, `sentry-sdk`, `Pillow`, `defusedxml` to runtime deps. Moves `pypdf`, `pypdfium2`, solvers and CI tools to optional | absent | v2 `core/requirements.txt` has none of the five runtime packages | skip the AI packages. The dependency lane decides on `defusedxml`/`sentry-sdk` for non-AI code | S | M |
| AI-16 | `e3a4905` `bac2e15` `d193968` `5689c84` `10be1ac` `8d02535` and compose parts of `b20aa81` `fd86e5e` `6f066a6` | `docker/compose.backend.yml`, `docker/compose.backend.memory.yml`, `docker/.env*.example`, `docker/nginx.backend.conf`, `docker/README.md`, `docker/e2b/README.md` | `ai` service, `postgres`, `pgadmin`, nginx `/ai/` route, AI env blocks | absent | v2 deploys through Coolify with its own Docker files. The docker lane owns these files | skip the AI services | M | M |
| AI-17 | `33bf2de` `29ea0df` `367b477` `022600c` | merge commits | Merges only | n/a | none | none | - | - |

## 4. Dependencies and order

1. Nothing outside the package depends on it. `grep` over v1 `core/nurse_scheduling` finds only `ai_serve.py` importing `nurse_scheduling.ai`. So excluding it blocks no other lane.
2. If you vendor or wire it, these must land first:
   - the auth lane: `server/auth.py` (`8142e57`, `073951e`, `3de3609`, `be0a8bc`, `820d054`);
   - `nurse_scheduling/sentry.py` (added in v1 before the base pin, `dfefa96`, and never ported to v2; `grep sentry` in the T19 manifest finds nothing);
   - the validation lane: `frontend_validation.py` (`9ff14d1`, `1fbdfb7`, `63dfc54`);
   - the dependency lane: `e2b`, `psycopg[binary]`, `Pillow`, `defusedxml`, `sentry-sdk`, and `pypdf`/`pypdfium2` for tests.
3. Inside the package, the order is AI-01 → AI-02 → AI-03 → AI-04 → AI-05 → the rest. Commits interleave heavily across files (for example `11a1b84` touches 17 files in scope). A partial port by commit is not practical. Port a whole `dev` snapshot or nothing.
4. `schema.py` needs an adaptation in v2 for its two repo-root paths before its tests pass.

## 5. Open decisions for the user

D1. What to do with `core/nurse_scheduling/ai/`. Recommendation: **exclude**.

| Option | What it costs |
| --- | --- |
| Vendor untouched, unused | About 9,250 package lines and 15,900 test lines. Also port `sentry.py`, `server/auth.py`, `frontend_validation.py`, or the package and about 30 test modules fail to import. Add 5 runtime packages (`e2b` pulls its own HTTP and protobuf stack, UNVERIFIED size) to the API image, or keep them test-only and skip the tests. Adapt `schema.py:34-35` or the tests fail. Keep up with about 25 commits per week of churn. The security surface is small while no process serves `ai_serve:app`, but the image carries the extra supply-chain packages. The gain is small: the package is a leaf, so "core close to v1" does not change for any other file. |
| Wire it | All of the vendor cost, plus: an `ai` service, a PostgreSQL service, an E2B account and key, an operator LLM key, an nginx or BFF route, a new Next.js client for the session API, and auth. It conflicts with ratified v2 decisions: BYO key, no server storage of chat text, user-confirmed optimizer runs, typed per-operation proposals. Security surface: model-written Bash in a third-party cloud, arbitrary uploaded files, stored chat text with personal data, a second public endpoint with cross-site cookies. |
| Exclude | No code, no deps, no services. Record it as `excluded` in `docs/T19-upstream-backend-source-manifest.md` with the reason ("v2 assistant is client-side BYO-key, see docs/ai-assistant.md"). Future syncs skip one directory by rule, which keeps them mechanical. |

D2. If you vendor anyway, decide whether the tests run in v2 CI. Recommendation: prefer exclusion (D1). If you vendor, install the AI packages as test-only deps and run the tests verbatim. Guards such as `pytest.importorskip("e2b")` change v1 files, which adds a patch to maintain.

D3. Port `sentry.py` for the rest of core. This is outside this lane, but the AI package needs it. Recommendation: let the observability or server lane decide on its own merits, not because of the AI package.

D4. Close v1 user-facing gaps in the v2 TypeScript assistant: file attachments (AI-11), steering queue (AI-09), "older messages dropped" warning (AI-10), chat export (v1 `chatExport.ts`), visible tool activity (AI-02). Recommendation: file beads for attachments and chat export only. Attachments give the most value for real wards (paper rosters, leave spreadsheets). Treat the others as low priority.

D5. Reuse the v1 evaluation cases. Recommendation: yes, as a prompt corpus only. Translate the 109 cases in `core/tests/ai_eval/cases/basics/**` into v2 eval prompts with v2 op expectations. Do not port the Python runner.

## 6. Coverage note

Every file in scope that changed between `d63519b` and `dev`, and the row that covers it. All are additions.

| File | Rows |
| --- | --- |
| `core/nurse_scheduling/ai/__init__.py` | AI-01 |
| `core/nurse_scheduling/ai/agent.py` | AI-02, AI-04, AI-09, AI-11 |
| `core/nurse_scheduling/ai/app.py` | AI-01, AI-02, AI-07, AI-09, AI-10, AI-12 |
| `core/nurse_scheduling/ai/attachment_tools/__init__.py` | AI-11 |
| `core/nurse_scheduling/ai/attachment_tools/inspect_pdf.py` | AI-11 |
| `core/nurse_scheduling/ai/attachment_tools/inspect_xlsx.py` | AI-11 |
| `core/nurse_scheduling/ai/background.py` | AI-10, AI-12 |
| `core/nurse_scheduling/ai/candidate.py` | AI-04 |
| `core/nurse_scheduling/ai/config.py` | AI-01, AI-03, AI-04, AI-07, AI-09, AI-10, AI-12 |
| `core/nurse_scheduling/ai/diff.py` | AI-02 |
| `core/nurse_scheduling/ai/history.py` | AI-08 |
| `core/nurse_scheduling/ai/migrations/001_chat_history.sql` | AI-08 |
| `core/nurse_scheduling/ai/migrations/002_arbitrary_attachments.sql` | AI-08, AI-11 |
| `core/nurse_scheduling/ai/optimizer.py` | AI-12 |
| `core/nurse_scheduling/ai/optimizer_privacy.py` | AI-12 |
| `core/nurse_scheduling/ai/pi/LICENSE`, `pi/__init__.py`, `pi/bash.py`, `pi/edit.py`, `pi/write.py` | AI-04 |
| `core/nurse_scheduling/ai/pi/read.py` | AI-04, AI-11 |
| `core/nurse_scheduling/ai/pi/image_process.py`, `pi/mime.py` | AI-11 |
| `core/nurse_scheduling/ai/prompts/sandbox-system.md` | AI-05, AI-12 |
| `core/nurse_scheduling/ai/provider.py` | AI-01, AI-02, AI-06 |
| `core/nurse_scheduling/ai/references/schema-core.md`, `schema-export.md`, `schema-preferences.md`, `schema-shift-request.md` | AI-05 |
| `core/nurse_scheduling/ai/sandbox/__init__.py`, `base.py`, `e2b.py`, `e2b_cleanup.py`, `factory.py`, `fake.py`, `reap.py` | AI-03 |
| `core/nurse_scheduling/ai/sandbox_agent.py` | AI-04, AI-05, AI-12 |
| `core/nurse_scheduling/ai/sandbox_tools.py` | AI-04, AI-11 |
| `core/nurse_scheduling/ai/schedule_context.py` | AI-05 |
| `core/nurse_scheduling/ai/schema.py` | AI-02, AI-05 |
| `core/nurse_scheduling/ai/validation.py` | AI-02, AI-13 |
| `core/nurse_scheduling/ai_serve.py` | AI-01 |
| `core/tests/ai_test_helper.py` | AI-02, AI-12 |
| `core/tests/test_ai_agent.py` | AI-02, AI-09 |
| `core/tests/test_ai_attachment_tools.py` | AI-11 |
| `core/tests/test_ai_basic.py` | AI-01, AI-07, AI-09, AI-10 |
| `core/tests/test_ai_candidate.py` | AI-04 |
| `core/tests/test_ai_diff.py`, `test_ai_validation.py` | AI-02 |
| `core/tests/test_ai_history.py` | AI-08 |
| `core/tests/test_ai_optimizer.py`, `test_ai_optimizer_privacy.py` | AI-12 |
| `core/tests/test_ai_pi_bash.py`, `test_ai_pi_edit.py`, `test_ai_pi_read.py`, `test_ai_pi_write.py` | AI-04 |
| `core/tests/test_ai_pi_image_process.py` | AI-11 |
| `core/tests/test_ai_provider.py` | AI-06 |
| `core/tests/test_ai_sandbox.py`, `test_ai_sandbox_e2b.py`, `test_ai_sandbox_e2b_cleanup.py`, `test_ai_sandbox_e2b_live.py`, `test_ai_sandbox_reap.py` | AI-03 |
| `core/tests/test_ai_sandbox_agent.py`, `test_ai_sandbox_tools.py` | AI-04 |
| `core/tests/test_ai_schedule_context.py`, `test_ai_schema.py` | AI-05 |
| `core/tests/test_ai_eval_grading.py`, `test_ai_eval_runner.py`, `test_ai_provider_preflight.py`, `test_ai_read_batch_benchmark.py` | AI-14 |
| `core/tests/test_ai_eval_attachment_fixtures.py` | AI-11, AI-14 |
| `core/tests/ai_eval/README.md`, `__init__.py`, `grading.py`, `runner.py`, `provider_preflight.py`, `read_batch_benchmark.py` | AI-14 |
| `core/tests/ai_eval/attachment_fixtures.py` | AI-11, AI-14 |
| `core/tests/ai_eval/fixtures/cross-year-unit.yaml`, `new-schedule.yaml`, `small-clinic.yaml` | AI-14 |
| `core/tests/ai_eval/cases/basics/**` (109 files: `00-summary` 3, `00-tools` 4, `01-reading` 7, `02-basic-edit` 7, `03-structure` 20, `04-preferences` 23, `05-export` 7, `06-refusal` 7, `07-multi-turn` 9, `08-proposal-lifecycle` 8, `09-holdout` 6, `10-app-ui` 4, `11-attachments` 4) | AI-14 |
| `docker/e2b/README.md`, `docker/e2b/build_template.py`, `docker/e2b/e2b.Dockerfile` | AI-03 |
| `scripts/start_ai_backend.sh` | AI-01 |
| AI blocks in `docker/compose.backend.yml`, `docker/compose.backend.memory.yml`, `docker/.env*.example`, `docker/nginx.backend.conf`, `docker/README.md` | AI-16 (the docker lane owns the rest of each file) |
| `core/requirements.txt`, `core/requirements-optional.txt` (AI packages only) | AI-15 |

Not in scope but related: `test_suspicious_requests.py` belongs to the server lane. `web-frontend/src/app/experimental-ai/**` and `docs/content/{ai-assistant,user-guide/experimental-ai}.md` belong to the frontend and docs lanes; they are read here only to describe v1 capabilities.

Method: `git log d63519b..dev` and `git diff --stat d63519b dev` on the scope paths, a `git archive dev` snapshot in `/tmp/v1ai` for reading, and grep of v2 `core/`, `web/lib/ai`, `web/components/ai`, `docs/ai-assistant.md`.

## Addendum: genie baseline

The coordinator confirmed that v2 tracks v1 branch `feature/genie` (HEAD `1bf4b85`), not `dev`. `feature/genie` holds all of `dev` plus genie-only commits. `git log --merges` shows `1b6f7e5 Merge dev into feature/genie` with parents `d63519b` and `d41a6c5`. The genie-only commits that touch this lane's paths are:

- `1b6f7e5` (the merge). Its conflict resolution carries almost all genie-only AI changes. `git log -m --first-parent dev..feature/genie -- core/nurse_scheduling/ai` lists only `ecb5eee` and `1b6f7e5`.
- `ecb5eee` fix(web-frontend): support whole calendar years of Singapore holidays. In scope it changes only `ai/references/schema-core.md` (5 lines).
- `64c84a3` feat: add shift working time and remove sentry (2026-07-15, before the pin). It deletes Sentry from genie. The merge `1b6f7e5` then removes the Sentry calls that `dev` added to the AI package.
- `7d1c220`, `f06402b`, `31c5125`, `7764e80`, `9aef889`, `96e9ba9` (July 2026, before the AI package existed). They add LEAVE, shift type covering, hours contracts, working time and the PH date group to core. They do not touch `ai/`, but the merge adapted the AI references to them.

Evidence: `git diff --stat dev feature/genie -- core/nurse_scheduling/ai core/nurse_scheduling/ai_serve.py docker core/tests/test_ai_* core/tests/ai_eval core/requirements.txt` shows 40 files, 865 insertions, 393 deletions.

### Module imports on feature/genie

Checked with `git cat-file -e feature/genie:<path>` and `git grep -i sentry feature/genie -- core/nurse_scheduling core/tests` (no match).

| Module or path the AI package needs | On `feature/genie` | In v2 core | Effect |
| --- | --- | --- | --- |
| `core/nurse_scheduling/sentry.py` | missing, and no longer imported (`1b6f7e5` deletes `from ..sentry import init_sentry` in `ai/app.py` and `ai/sandbox/reap.py`) | missing | The Sentry blocker from section 4 is gone on the genie baseline |
| `core/nurse_scheduling/server/auth.py` | exists | missing | Still a blocker (`ai/app.py`, `ai/config.py`) |
| `core/nurse_scheduling/frontend_validation.py` | exists | missing | Still a blocker (`ai/validation.py`) |
| `docs/content/user-guide/` (read by `ai/schema.py`) | exists | missing (no `docs/content` in v2) | Still a blocker |
| `web-frontend/src/utils/singaporeHolidays.ts` (read by `ai/schema.py`, replaces `taiwanHolidays.ts`) | exists | missing. v2 has `web/lib/dates/holidays-sg.ts` at a different path | Still a blocker, same cause as before with a new file name |
| `SHIFT_TYPE_COVERING`, `LEAVE` in `models.py` / `constants.py` | exist | exist (`core/nurse_scheduling/models.py:28,36`) | No blocker for `optimizer_privacy.py` |

### Genie-only change table

Tags: DEV = the row in section 3 applies unchanged on genie. GENIE-ONLY = the change exists only on `feature/genie`.

| ID | Tag | v1 commits | Files | What it does | v2 status | Proposed action | Effort | Risk |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| G-01 | GENIE-ONLY | `1b6f7e5` | `ai/app.py`, `ai/background.py`, `ai/sandbox_agent.py`, `ai/schema.py`, `ai/prompts/sandbox-system.md`, `tests/test_ai_basic.py`, `tests/test_ai_sandbox_agent.py`, `tests/test_ai_schema.py` | Replace Taiwan holidays with Singapore holidays. `CreateSessionRequest` and `UpdateScheduleRequest` accept `singapore_holidays` (the browser's cached data.gov.sg rows, model `SingaporeHolidayEntry`, max 1,000). The session stores them, and each sandbox turn writes them to `/reference/singaporeHolidays.json` next to `/reference/singaporeHolidays.ts`. The prompt tells the model to rebuild WORKDAY, NON-WORKDAY and PH groups from both files | absent. v2 builds Singapore holiday groups in the browser (`web/lib/dates/holiday-groups.ts`, `holidays-sg.ts`) | skip (part of the excluded package) | M | L |
| G-02 | GENIE-ONLY | `1b6f7e5`, `64c84a3` | `ai/app.py`, `ai/sandbox/reap.py`, `core/requirements.txt`, `docker/compose.backend.yml`, `docker/compose.backend.memory.yml`, `docker/.env*.example`, `docker/README.md` | Remove Sentry: drop `init_sentry` calls, drop `sentry-sdk` from requirements, drop the `sentry-environment` anchor from compose | absent (v2 never had Sentry in core) | none. It removes one blocker if the package is ever vendored | S | L |
| G-03 | GENIE-ONLY | `1b6f7e5` | `ai/optimizer_privacy.py`, `tests/test_ai_optimizer_privacy.py` | Anonymize `preceptors` and `preceptees` in `shift type covering` rules before optimizer submission | absent | skip (excluded package) | S | L |
| G-04 | GENIE-ONLY | `1b6f7e5`, `ecb5eee` | `ai/references/schema-core.md`, `schema-preferences.md`, `schema-shift-request.md` | Teach the agent LEAVE (history, reserved ID, `shiftType: [LEAVE]` hard pin), shift working time (`durationMinutes`, `startTime`, `endTime`, `restMinutes`), `hoursContract` on shift count, `shift type covering`, whole calendar years of Singapore holidays | absent | skip the code. These references are the best v1 text to mine for the v2 playbook (D5) because they describe genie features that v2 has | S (mining) | L |
| G-05 | GENIE-ONLY | `1b6f7e5` | `tests/ai_eval/runner.py`, `tests/test_ai_eval_runner.py`, `tests/ai_eval/fixtures/singapore-holidays.json` (new, 522 lines), 12 case files under `tests/ai_eval/cases/basics/` (3 renamed from `*-taiwan-*` to `*-singapore-*`) | Adapt the evaluation harness and cases to Singapore holidays and genie schema | absent | skip the harness. The case corpus for D5 must come from genie, not `dev` | S | L |
| G-06 | GENIE-ONLY | `1b6f7e5` and earlier genie commits (UNVERIFIED which one deletes each file) | `docker/Dockerfile.dev.cuopt` (deleted), `docker/.env.gpu.example` (deleted), `docker/Dockerfile.api`, `Dockerfile.api.staging`, `Dockerfile.api.staging.dockerignore` (1 line each), suspicion env vars removed from compose | Remove cuOpt and GPU build files, and the suspicious-request counter settings, from the backend compose | absent (v2 has its own Docker files) | docker lane decides. No effect on this lane | S | L |
| AI-01 to AI-17 | DEV | as in section 3 | as in section 3 | as in section 3 | absent | as in section 3 | - | - |

### Effect on decisions D1 to D5

- D1 (exclude the package): unchanged. Genie removes the Sentry blocker, but three blockers remain in v2: `server/auth.py`, `frontend_validation.py`, and the two repo-root paths in `ai/schema.py` (now `docs/content/user-guide` and `web-frontend/src/utils/singaporeHolidays.ts`). G-01 also adds a new session contract (`singapore_holidays` in the request body) that a v2 client would have to send. The product conflicts in section 5 (operator key, server chat log, model-written Bash) are the same on genie.
- D2 (tests in CI if vendored): unchanged. Genie drops `sentry-sdk` from runtime deps, so the extra runtime packages go from 5 to 4 (`psycopg[binary]`, `e2b`, `Pillow`, `defusedxml`).
- D3 (port `sentry.py`): no longer applies. Genie deleted Sentry (`64c84a3`), so porting it moves v2 away from its tracked baseline. Recommendation: do not port `sentry.py`.
- D4 (v2 feature gaps): unchanged. Genie adds no user-facing AI feature. It only adapts the existing ones to Singapore holidays and genie schema.
- D5 (reuse eval cases and references): unchanged in direction, with one correction. Take the case corpus and the `references/schema-*.md` text from `feature/genie`, not from `dev`, because only genie matches v2's Singapore holidays, LEAVE, covering and hours-contract model.

### Coverage of genie-only files in scope

| File | Row |
| --- | --- |
| `ai/app.py` | G-01, G-02 |
| `ai/background.py`, `ai/sandbox_agent.py`, `ai/schema.py`, `ai/prompts/sandbox-system.md` | G-01 |
| `ai/optimizer_privacy.py` | G-03 |
| `ai/references/schema-core.md`, `schema-preferences.md`, `schema-shift-request.md` | G-04 |
| `ai/sandbox/reap.py`, `core/requirements.txt` | G-02 |
| `tests/test_ai_basic.py`, `tests/test_ai_sandbox_agent.py`, `tests/test_ai_schema.py` | G-01 |
| `tests/test_ai_optimizer_privacy.py` | G-03 |
| `tests/ai_eval/runner.py`, `tests/test_ai_eval_runner.py`, `tests/ai_eval/fixtures/singapore-holidays.json`, the 12 changed files in `tests/ai_eval/cases/basics/**` | G-05 |
| `docker/.env.example`, `.env.staging.example`, `compose.backend.yml`, `compose.backend.memory.yml`, `README.md` | G-02, G-06 |
| `docker/.env.gpu.example`, `Dockerfile.dev.cuopt`, `Dockerfile.api`, `Dockerfile.api.staging`, `Dockerfile.api.staging.dockerignore` | G-06 |
