# Install

Pick your agent below. Claude Code installs from GitHub; the other routes use a
clone of this repository (`/path/to/Creole-LLM` below). The hooks run
`node`, so Node.js 22.18 or newer must be on the PATH of the agent's
non-interactive shell. Not listed? Use [any other agent](#any-other-agent).

Each section names its tier.

| Tier | Meaning |
|---|---|
| live-verified | Observed in live sessions on the named host version |
| mock-tested | Deterministic tests or a stand-in provider, no live session |
| instruction | Creole's rules load every session through the agent's own rules file, in the format the compared plugins ship; no automatic compaction, sharing or storage |

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

**Tier: mock-tested.** The same extension and skills as omp, declared under `pi` in
`package.json`. Install the checkout as a pi package by pi's own instructions, and
remove it the same way.

## Cursor

**Tier: instruction.** `.cursor/rules/creole.mdc` is an always-on project rule: copy
it into your project's `.cursor/rules/`. For automatic compaction as well,
`hooks/cursor-hooks.json` is a hooks template: replace `CREOLE_DIR` with the
checkout's absolute path and merge its `hooks` entries into `~/.cursor/hooks.json`.
Uninstall: delete the rule and remove those entries.

## Windsurf, Cline, Kiro, Qoder

**Tier: instruction.** Copy the rule file into your project, or into the agent's
global rules folder:

| Agent | File |
|---|---|
| Windsurf | `.windsurf/rules/creole.md` |
| Cline | `.clinerules/creole.md` (global: `~/.cline/rules/`) |
| Kiro | `.kiro/steering/creole.md` |
| Qoder | `.qoder/rules/creole.md` |

Uninstall: delete the copied file.

## GitHub Copilot

**Tier: instruction.** Copy `.github/copilot-instructions.md` into your repository's
`.github/` (Copilot CLI: `~/.copilot/copilot-instructions.md` for every project).

## Gemini CLI and Qwen Code

**Tier: instruction.** Both read `AGENTS.md` when it is set as a context file: copy
this repository's `AGENTS.md` into your project and add it to `context.fileName` in
the agent's `settings.json`. For automatic compaction as well on Gemini CLI,
`hooks/gemini-hooks.json` is a hooks template: replace `CREOLE_DIR` with the
checkout's absolute path and merge its `hooks` object into `settings.json`.

## Kimi Code

**Tier: instruction.** `.kimi-plugin/plugin.json` puts `AGENTS.md` into the system
prompt every turn and lists the skill. Install the checkout as a Kimi plugin by
Kimi's own instructions.

## OpenCode

**Tier: mock-tested.** Add the npm package to `opencode.json` (OpenCode installs it):

```json
{ "plugin": ["creole-llm"] }
```

From a clone instead: `{ "plugin": ["/path/to/Creole-LLM/.opencode/plugins/creole.mjs"] }`.

It adds Creole's rules to every turn's system prompt and registers the skill. For
the command, copy `.opencode/command/creole.md` into `.opencode/command/`. Uninstall:
remove the entry.

## GitHub Copilot CLI

**Tier: mock-tested.** The plugin's `sessionStart` hook (`hooks/copilot-hooks.json`)
gives the agent Creole's rules at the start of every session. Copilot reads hook
output only there, so it gets no automatic compaction.

```sh
copilot plugin marketplace add gluppler/Creole-LLM
copilot plugin install creole@creole-llm
```

Uninstall: `copilot plugin uninstall creole@creole-llm`.

## Devin CLI

**Tier: instruction.**

```sh
devin plugins install gluppler/Creole-LLM
```

Uninstall: `devin plugins remove creole`.

## Grok Build

**Tier: instruction.**

```sh
grok plugin install gluppler/Creole-LLM --trust
```

Then enable it in `/plugins`. Uninstall: `grok plugin uninstall creole`.

## Cursor plugin and Qoder plugin

**Tier: mock-tested.** `.cursor-plugin/plugin.json` and `.qoder-plugin/plugin.json`
install the skill through each host's plugin installer, pointed at this repository or
a clone of it, and run Creole's command hooks (`hooks/cursor-plugin-hooks.json`,
`hooks/qoder-hooks.json`; the host fills in its plugin root): the rules every
session, automatic compaction prompts and session records, as on Codex.

## Skills CLI

**Tier: instruction.** The [skills CLI](https://skills.sh) copies the Creole skill into
the skills folder of many agents:

```sh
npx skills add gluppler/Creole-LLM
```

Pick the agent with `--agent`, and add `--global` to install for your user instead of
the project. This installs the skill only: for the always-on rules, also add
[`AGENTS.md`](AGENTS.md) or use one of the plugins above. Uninstall:
`npx skills remove creole` (same `--agent` and `--global` flags as the install).

## Any other agent

**Tier: instruction.** Agents that read `AGENTS.md` from the project (Amp, Zed,
Jules, Goose, Junie, Factory Droid, Antigravity, the Codex IDE extension and others)
get Creole's rules from this repository's [`AGENTS.md`](AGENTS.md): copy it into your
project root. Agents that read skills: copy `skills/creole/` into their skills
folder. Uninstall: delete the copied file or folder.

## Data left behind

| Data | Where | Removed by uninstall |
|---|---|---|
| Session records (Claude Code) | `user:<session id>` entries in the plugin's file under `~/.claude/plugins/store/` | Unverified; delete by hand with Claude Code closed |
| Session records (command hooks: Codex, Cursor, Qoder) | `sessions/<session id>/` under `CLAUDE_PLUGIN_DATA`, then `PLUGIN_DATA`, else `~/.creole` (Codex: its plugin data folder above) | No; delete by hand with the agent closed |
| Copilot CLI, OpenCode, rules-file agents | Nothing: Creole only adds its rules | Nothing to remove |
| Memory-file backups from `/creole compress` | `backups/` under the agent shell's `CLAUDE_PLUGIN_DATA`, then `PLUGIN_DATA`, else `~/.creole` (the script prints the path) | No; Creole never removes them |
| Host transcripts and provider logs | The host's and the provider's own stores | No; outside Creole |

A session's record is removed at a later session start once the host has ended
that session and 30 days have passed untouched. Credential redaction is
pattern-based and does not remove other personal data.
