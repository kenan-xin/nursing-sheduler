# Project Instructions for AI Agents

This file provides instructions and context for AI coding agents working on this project.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:970c3bf2 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   bd dolt push
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->


## Build & Test

_Add your build and test commands here_

```bash
# Example:
# npm install
# npm test
```

## Architecture Overview

_Add a brief overview of your project architecture_

## Conventions & Patterns

### Branch and deploy flow

This is a team convention. GitHub does not enforce it.

1. Do not commit directly to `main`.
2. Create each feature or fix branch from `develop`, in its own worktree: from the repo root, run `wt switch --create <branch> --base develop --no-cd`.
3. Merge the branch back into `develop`. A push to `develop` deploys the dev environment, https://nurse-scheduler-dev.agilgenie.ai.
4. To release, open a pull request from `develop` into `main`. Merging it deploys production, https://nurse-sheduler.agilgenie.ai, through the Coolify GitHub webhook.

CI runs on pushes to `main` and `develop`, and on every pull request.

## Library-First Testing: No Repository-Owned Parsers

This repository **does not own source-analysis code**. Do not add a hand-written TypeScript
compiler walk, a regex/string TSX "parser", a source-level control-flow analyzer, or a
repository-owned lint plugin. If a guarantee seems to need one, it belongs at a layer that can
express it honestly.

**Move each guarantee to the first layer that can own it:**

1. a **production API** that makes the invalid state unavailable (the strongest — an absent
   capability defeats aliasing, destructuring and bracket access at once);
2. **TypeScript** compiler options and `*.negative.test-d.ts` fixtures, where every
   `@ts-expect-error` fails the build the moment it stops erroring;
3. **Oxlint** native rules with exact per-path overrides (`no-restricted-imports`,
   `no-restricted-properties`, the targeted `import`/`vitest` rules);
4. **Vitest / Testing Library / Playwright** against public runtime behaviour and the shipped
   mounting path;
5. **ast-grep** YAML rules — declarative syntax only, each with valid/invalid fixtures — for the
   residual authored-source patterns the first four cannot reach.

Prefer a maintained library over anything hand-rolled. A custom implementation requires a
written comparison showing why the maintained tools are inadequate or materially worse. When a
rule starts to need a symbol table, alias resolution, spread evaluation or control-flow
reasoning, **change the production API instead of teaching the matcher to reason.**

This remains an Oxlint repository (no ESLint migration). Vitest is a test runner, not a
source-analysis engine.

### The acquisition boundary in test/support code

Test and support code — `**/*.{test,spec}.{ts,tsx,js,jsx,mjs,cjs,mts,cts}`, `e2e/**`,
`__tests__` subtrees, and test-only helpers — may **not** acquire:

- a **compiler or parser library** (`typescript`, `ts-morph`, `@babel/*`, `acorn`, `esprima`,
  `espree`, `tree-sitter*`, `recast`, `jscodeshift`, `@swc/*`, `oxc-parser`, `@ast-grep/*`).
  **This family has no exception anywhere.**
- a **generic filesystem** capability (`node:fs`, `fs`, `node:fs/promises`, `fs/promises`, and
  the usual re-wrappers);
- a **generic module loader** (`node:module`/`createRequire`, `process.getBuiltinModule`).

**Oxlint owns every literal module SPECIFIER — static and dynamic alike.** A probe on the
installed Oxlint 1.74 confirms `no-restricted-imports` rejects `await import("node:fs")` just as
it rejects a static import, so do not add an ast-grep rule for `import()`: it would duplicate an
existing owner. **ast-grep owns only the residual shapes Oxlint cannot express** — `require()`,
a `createRequire` call including a locally-named loader handle, `process.getBuiltinModule()`,
and reading a literal `.ts`/`.tsx` path.
Production code is deliberately **not** restricted (`web/scripts/start-standalone.mjs`
legitimately reads the filesystem); the policy is scoped to test/support code.

**Need to read a fixture?** Use a format-specific helper, not a generic "read arbitrary source
text" one, and get an exact per-file exception recorded with its API, root/path class,
extension/format and write permission. Exceptions are granted to a **file**, never a directory
glob. A file that opens a production `.ts`/`.tsx` for its **contents** gets none — and neither
does a known source analyzer. A directory listing (`readdirSync`) and a path-existence check
(`existsSync`) are not source reads.

**Where it is enforced** (all in `web/`):
`pnpm lint` = `oxlint && ast-grep scan`. `pnpm test:ast-grep` runs the rule fixtures.
`oxlint-boundary-config.test.ts` pins the whole Oxlint config; `ast-grep-substrate.test.ts`
proves no rule scope has gone stale; `ast-grep-rule-pairs.test.ts` keeps language variants in
step; `acquisition-prevention.test.ts` materialises each bypass family and asserts the normal
lint command rejects it.

**The claim, stated honestly:** this is an *acquisition boundary plus an audited exception
list*. It does not prove arbitrary byte provenance, resolve constructed paths, or close every
metaprogramming route — including inside the audited exceptions, where review remains the
control.

## Design Context

`PRODUCT.md` and `DESIGN.md` at the project root carry the design system for the web app (register: `product`). North Star: **"Mint Canvas, Warm Ink"** (adopted 2026-07-27, replacing "The Ward Instrument") — warm espresso ink and warm hairlines on a cool recessed mint canvas, a stepped L0→L2 surface ladder where tone carries separation before shadow does, and selective rounding (cards 16px / controls 12px / chips 9px / pill buttons) with every data surface held square.

**`DESIGN.md` describes the shipped system.** The v2 re-skin has landed: every shipped route in `web/` implements "Mint Canvas, Warm Ink", and `web/app/globals.css` — the single runtime value authority — agrees with `DESIGN.md`. Should the two ever drift, `DESIGN.md` is canon: reconcile the code to it, not the reverse.

The canonical UI reference is the v2 bundle at `docs/design_prototype/` — `standalone/nurse-scheduling-v2-standalone.html` to click through, `source/Screen*.dc.html` for markup. Prototype fidelity is scoped to the **visual system**. Precedence is product contracts and ratified decisions → `DESIGN.md` visual rules → prototype examples; the bundle never silently overrides behaviour, architecture, data contracts, or feature priority. See `DESIGN.md` §1 for the complete deviation matrix, including removed Customise/pinning and the separate deferred Export Layout route. Run `/impeccable document` to refresh `DESIGN.md` if the visual system drifts from these files.
