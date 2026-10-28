<h1 align="center">creole-llm</h1>

<p align="center">
  <em>Fewer tokens. Same work. The agent keeps what matters when the context fills up.</em>
</p>

<p align="center">
  <a href="https://github.com/gluppler/Creole-LLM/actions/workflows/test.yml"><img src="https://github.com/gluppler/Creole-LLM/actions/workflows/test.yml/badge.svg" alt="Tests"></a>
  <img src="https://img.shields.io/badge/works%20with-20%2B%20agents-111111?style=flat-square" alt="Works with 20+ agents">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-111111?style=flat-square" alt="MIT license"></a>
</p>

<p align="center">
  <strong>-46% cost on a 30-issue session &middot; -24% with subagents &middot; -35% on a short fix</strong><br>
  <sub>Against plain Claude Code, every session passing the same tests. Claude Code 2.1.292, Haiku 4.5. <a href="#numbers">Details</a>.</sub>
</p>

---

## Install

Claude Code:

```sh
claude plugin marketplace add gluppler/Creole-LLM
claude plugin install creole@creole-llm
```

Other agents:

| Agent | Install |
|---|---|
| GitHub Copilot CLI | `copilot plugin marketplace add gluppler/Creole-LLM`, then `copilot plugin install creole@creole-llm` |
| Devin CLI | `devin plugins install gluppler/Creole-LLM` |
| Grok Build | `grok plugin install gluppler/Creole-LLM --trust` |
| OpenCode | add `"creole-llm"` to `plugin` in `opencode.json` |
| npm (any tool that installs packages) | `npm install creole-llm` |
| Codex, Cursor, Qoder, omp, pi | install from a clone: [INSTALL.md](INSTALL.md) |
| Any agent with skills | `npx skills add gluppler/Creole-LLM` |
| Any agent that reads `AGENTS.md` or a rules folder | copy [`AGENTS.md`](AGENTS.md), or the rules file for your agent |

Every agent, uninstalling and the data Creole leaves behind: [INSTALL.md](INSTALL.md).

## What it does

creole-llm is a plugin that makes a coding agent cheaper on long sessions without
forgetting the task, by teaching it Creole, a compact working language. No training,
no GPU, no second model.

1. **A compact working language.** The agent thinks, plans and replies in plain English
   words in the shape of code: one fact per line, no filler, every number and error kept.
2. **Compaction that keeps the task.** When the context fills, the conversation becomes
   a session graph of about 250 words (task, the user's constraints word for word, what
   is built, decisions, open issues, the last step) plus the user's own messages.
3. **One record for every agent.** Subagents start from the session graph and merge
   what they learn back into it, so the main agent and its subagents share one wiki.
4. **Works beside other plugins.** Another plugin's rules win for what they prescribe,
   and after each compaction the agent is told to reload the skills it had invoked.
5. **Runs on 20+ agents.** Compaction on Claude Code, Codex, Cursor, Qoder, omp and pi;
   the rules every turn on OpenCode and at session start on Copilot CLI; and the rules
   file on every agent that reads `AGENTS.md` or a rules folder.

## Before / after

<table>
<tr>
<td width="50%" valign="top">

**Before**

> 6 tests are still failing:
>
> - `test_blend_bucket_700` (util8): expects 31, got 32
> - `test_clamp_bucket_723` (util8): expects 20, got 21
> - ... four more ...
>
> All 6 failures are in util8.py, which you explicitly withdrew from the task.
> These are not to be fixed per your constraint.

</td>
<td width="50%" valign="top">

**After**

> Done: issues 1-24 fixed; the 6 you withdrew still fail, as asked.<br>
> checked: `python3 -m unittest discover -s tests -t .` -> 24 pass, 6 withdrawn fail<br>
> next: none

</td>
</tr>
</table>

## The rules

Full text in [SKILL.md](skills/creole/SKILL.md).

1. One fact, step or action per line; drop filler, keep every meaning-bearing word.
2. Read the code a change touches first; take the first option that fully works.
3. The shortest working diff wins; never cut validation, safety or accessibility.
4. Find every target with one search; stop once the checks pass.
5. Reply with the outcome, what was checked, and the next action. Nothing else.
6. Another skill or plugin in force wins for what it prescribes.

## Numbers

Cost per session on scripted coding sessions, every session passing the task's tests
and keeping the user's constraints. Each plugin runs in its own sandbox with a pinned
copy.

| Task | Creole | native | Ponytail | i-have-adhd | Caveman | llm-wiki |
|---|---|---|---|---|---|---|
| bugfix-review: 30 issues, two compactions | **$0.441** | $0.818 | $0.520 | $0.496 | $0.523 | $0.732 |
| review-subagents: two subagents share the graph | **$0.588** | $0.772 | | | | $0.801 |
| bugfix-two: short fix, no compaction | $0.092 | $0.143 | $0.104 | $0.097 | **$0.090** | $0.100 |

- Cheaper than plain Claude Code on every task.
- Under a preregistered win rule (quality at least the rival's, cost and token
  intervals both below zero), the subagents comparison is won against llm-wiki. The
  other comparisons need more repetitions; single sessions vary by about a quarter.
- Not shown: lower cost on every kind of task, public benchmark scores, or five hours
  of maximum-effort work.

## Support

| Agent | Route | Tier |
|---|---|---|
| Claude Code 2.1.292 | function hooks (`hooks/creole-module.mjs`) | live-verified |
| Codex 0.162.1 | command hooks | mock-tested |
| omp, pi | extension (`extensions/creole.ts`) | mock-tested; no session wiki |
| Windsurf, Cline, Kiro | their rules folders | instruction |
| GitHub Copilot | `.github/copilot-instructions.md` | instruction |
| Gemini CLI, Qwen Code, Kimi Code | `AGENTS.md` as context, `.kimi-plugin/` | instruction |
| OpenCode | server plugin (`.opencode/plugins/creole.mjs`) | mock-tested |
| Cursor, Qoder | plugins with Creole's hooks (or a rules file) | mock-tested |
| GitHub Copilot CLI | plugin, rules at session start | mock-tested |
| Devin CLI, Grok Build | their plugin installers | instruction |
| Amp, Zed, Jules, Goose, Junie and any agent that reads `AGENTS.md` | `AGENTS.md` | instruction |

Tiers are defined in [INSTALL.md](INSTALL.md).

## Settings

| Setting | Default / behavior |
|---|---|
| `CREOLE_HEADROOM_TOKENS` | 100000; compact once the context has grown this far past its smallest size (below 100k, the window's share binds) |
| `CREOLE_THRESHOLD_PERCENT` | 60; never let the context pass this share of the window first |
| `CREOLE_CONTEXT_WINDOW_TOKENS` | For routes without a host-reported window |
| `CREOLE_MAX_WORDS` | 250; the graph's target, soft after one correction |
| `CREOLE_LANGUAGE` | On; `off` removes the language and its work and reply rules |
| `CREOLE_WIKI` | On; `off` stops the session wiki and the codebase map, and deletes nothing |
| `CREOLE_AUTO_COMPACT=0` | Stops the compactions the omp extension starts |
| `CREOLE_CHECKPOINT` | `graph`; `natural` and `proposal` exist for comparison experiments only |

Nothing to configure: the defaults adapt on their own (an unset headroom grows when
compactions come close together and shrinks back). To override one, set its `CREOLE_*`
environment variable. Claude Code's own auto-compaction settings win
over Creole's. Each compaction says what it did, or why Creole could not and the host
compacted instead; `--debug-file <path>` logs every turn, compaction and subagent merge.

**Privacy.** Session records (the user's messages with known credential patterns
removed, and the last graph) stay on your machine, capped at 256 KiB per session and
3 MiB in all, and are removed 30 days after a session ends. Redaction is pattern-based.
Where they live and how to delete them: [INSTALL.md](INSTALL.md#data-left-behind).

## Limits

- Compaction is lossy: the agent may re-read what the graph left out.
- The language section (about 3,500 characters) rides on every request.
- A subagent's rows are a model's words; of two subagents changing one row, the later
  merge wins.
- Labels around the graph and the codebase map do not stop a model from following a
  hostile line inside them.

## Development

```sh
npm test
```

Node 22.18 or later. Start at [CONTRIBUTING.md](CONTRIBUTING.md). The rules files for
other agents are written from the skill: after editing `skills/creole/SKILL.md`, run
`node scripts/sync-rules.mjs` (the tests fail while they differ). The project proposal
is in [thesis/](thesis/).

## License

[MIT](LICENSE).
