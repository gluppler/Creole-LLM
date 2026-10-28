# Contributing

Creole's behavior lives in one file, the canonical skill
[`skills/creole/SKILL.md`](skills/creole/SKILL.md). This guide points at it and
at the code. `AGENTS.md` and each agent's rules file hold the skill's Language
section, written by `node scripts/sync-rules.mjs`; never edit them by hand.

## Use Creole in a project

Read `skills/creole/SKILL.md` and follow its Language section for the whole
session. Without a Creole plugin in the host that is all Creole can do: nothing
compacts the conversation, shares the session graph with subagents or stores it
([INSTALL.md](INSTALL.md#any-other-agent)).

## Work on this repository

1. [README.md](README.md) says what Creole does; [INSTALL.md](INSTALL.md) covers every harness.
2. Keep evidence separate from claims: a passing deterministic test is not a
   live-host or benchmark result. Run the checks below before proposing a change.
3. To change behavior, change the skill first; the adapters stay thin.

| Area | Location |
|---|---|
| Canonical skill | `skills/creole/SKILL.md` |
| Graph, replay, language and session-wiki helpers | `lib/creole-graph.mjs` |
| Storage, logs and command-hook dispatch | `lib/creole-core.mjs`, `lib/creole-hooks.mjs`, `hooks/creole-hook.mjs` |
| Claude Code | `.claude-plugin/`, `hooks/creole-module.mjs` (function hooks), `hooks/hooks.json` (command-hook fallback) |
| Codex | `.codex-plugin/`, `.agents/plugins/`, `hooks/codex-hooks.json` |
| omp and pi | `package.json`, `extensions/creole.ts` |
| Cursor and Gemini CLI templates | `hooks/cursor-hooks.json`, `hooks/gemini-hooks.json` |
| Tests | `tests/`; language fixtures in `experiments/language/` |
| Thesis material | `thesis/` |

Checks: `npm test`. Installing into a live host, commits, pushes and publication
need the user's approval.
