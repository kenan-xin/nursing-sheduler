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

_Add your project-specific conventions here_

## Design Context

`PRODUCT.md` and `DESIGN.md` at the project root carry the design system for the web app (register: `product`). North Star: **"Mint Canvas, Warm Ink"** (adopted 2026-07-27, replacing "The Ward Instrument") — warm espresso ink and warm hairlines on a cool recessed mint canvas, a stepped L0→L2 surface ladder where tone carries separation before shadow does, and selective rounding (cards 16px / controls 12px / chips 9px / pill buttons) with every data surface held square.

**`DESIGN.md` describes the shipped system.** The v2 re-skin has landed: every shipped route in `web/` implements "Mint Canvas, Warm Ink", and `web/app/globals.css` — the single runtime value authority — agrees with `DESIGN.md`. Should the two ever drift, `DESIGN.md` is canon: reconcile the code to it, not the reverse.

The canonical UI reference is the v2 bundle at `docs/design_prototype/` — `standalone/nurse-scheduling-v2-standalone.html` to click through, `source/Screen*.dc.html` for markup. Prototype fidelity is scoped to the **visual system**. Precedence is product contracts and ratified decisions → `DESIGN.md` visual rules → prototype examples; the bundle never silently overrides behaviour, architecture, data contracts, or feature priority. See `DESIGN.md` §1 for the complete deviation matrix, including removed Customise/pinning and the separate deferred Export Layout route. Run `/impeccable document` to refresh `DESIGN.md` if the visual system drifts from these files.
