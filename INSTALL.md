# Install

Pick your agent below. Every route installs from a local checkout of this
repository: replace `/path/to/Creole-LLM` with its absolute path. The hooks run
`node`, so Node.js 22.18 or newer must be on the PATH of the agent's
non-interactive shell. Not listed? Use [any other agent](#any-other-agent).

Each section names its tier. Release 1.0.0 supports one route, Claude Code; the
others ship unsupported.

| Tier | Meaning |
|---|---|
| live-verified | Observed in live sessions on the named host version |
| mock-tested | Deterministic tests or a stand-in provider only, no live session |
| template-unverified | A configuration template ships; it has not run on that host |
| manual | Instructions only: no automatic compaction, sharing or storage |

## Claude Code

**Tier: live-verified** on Claude Code 2.1.292 (the function hooks).

```sh
claude plugin marketplace add gluppler/Creole-LLM
claude plugin install creole@creole-llm
```

`claude plugin list` then shows `creole@creole-llm`. Start a new session.
To try it for one session without installing, clone the repository and run
`claude --plugin-dir /path/to/Creole-LLM`.

Uninstall:

```sh
claude plugin uninstall creole@creole-llm
claude plugin marketplace remove creole-llm
```

Creole keeps each session's record (the user's messages, redacted, and the
session graph) as `user:<session id>` entries in the plugin's file under
`~/.claude/plugins/store/`. Whether uninstalling removes that file is
unverified: with Claude Code closed, delete it by hand. See
[data left behind](#data-left-behind).

## Codex

**Tier: mock-tested** on Codex 0.162.1 (the command hooks; no live run).

```sh
git clone https://github.com/gluppler/Creole-LLM
codex plugin marketplace add /path/to/Creole-LLM
codex plugin add creole@creole-llm
```

Start a new thread. Uninstall:

```sh
codex plugin remove creole@creole-llm
codex plugin marketplace remove creole-llm
```

Codex gives the plugin's hooks their own data folder,
`~/.codex/plugins/data/creole-creole-llm/` (under `CODEX_HOME` when set), with
one `sessions/<thread id>/` folder per thread. Delete it by hand with Codex closed.

## Oh My Pi (omp)

**Tier: mock-tested** (deterministic tests of `extensions/creole.ts`).

```sh
git clone https://github.com/gluppler/Creole-LLM
omp plugin install /path/to/Creole-LLM
```

For one session without installing: `omp -e /path/to/Creole-LLM/extensions/creole.ts`.
`CREOLE_AUTO_COMPACT=0` stops the compactions the extension starts.
omp has no subagent events, so it gets the language, the graph and the codebase
map, not the session wiki.

Uninstall: `omp plugin uninstall creole-llm`. omp keeps the graph in memory and
the extension stores nothing of its own.

## Pi

**Tier: template-unverified.** `package.json` declares the same extension and
skills under `pi` as under `omp`; pi itself has not been run. Install the
checkout as a pi package by pi's own instructions, and remove it the same way.

## Cursor

**Tier: template-unverified.** `hooks/cursor-hooks.json` is a hooks template:
replace `CREOLE_DIR` with the checkout's absolute path, then merge its `hooks`
entries into `~/.cursor/hooks.json` (or a project's `.cursor/hooks.json`),
keeping hooks you already have. Uninstall: remove those entries. Session records
go to the [Node data folder](#data-left-behind).

## Gemini CLI

**Tier: template-unverified.** `hooks/gemini-hooks.json` is a hooks template:
replace `CREOLE_DIR` with the checkout's absolute path, then merge its `hooks`
object into Gemini CLI's `settings.json`. Uninstall: remove those entries.
Session records go to the [Node data folder](#data-left-behind).

## Any other agent

**Tier: manual.** OpenCode, and any agent that reads skills or `AGENTS.md`:
copy `skills/creole/` into the agent's skills folder, or point the agent at
[`skills/creole/SKILL.md`](skills/creole/SKILL.md) (this repository's
[`AGENTS.md`](AGENTS.md) does so). The agent then works in the Creole language
and can write session graphs, but nothing compacts the conversation, shares the
graph with subagents or stores it. Uninstall: delete the copied folder.

## Data left behind

| Data | Where | Removed by uninstall |
|---|---|---|
| Session records (Claude Code) | `user:<session id>` entries in the plugin's file under `~/.claude/plugins/store/` | Unverified; delete by hand with Claude Code closed |
| Session records (command hooks) | `sessions/<session id>/` under `CLAUDE_PLUGIN_DATA`, then `PLUGIN_DATA`, else `~/.creole` (Codex: its plugin data folder above) | No; delete by hand with the agent closed |
| Memory-file backups from `/creole compress` | `backups/` under the agent shell's `CLAUDE_PLUGIN_DATA`, then `PLUGIN_DATA`, else `~/.creole` (the script prints the path) | No; Creole never removes them |
| Host transcripts and provider logs | The host's and the provider's own stores | No; outside Creole |

A session's record is removed at a later session start once the host has ended
that session and 30 days have passed untouched. Credential redaction is
pattern-based and does not remove other personal data.
