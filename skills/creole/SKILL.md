---
name: creole
description: Creole, the agent's compact working language for thinking, notes and replies, and the session graph, the task and working state that replace the conversation at compaction and that the session's subagents share. Hooks apply the language from session start; load this skill when the user asks for Creole or the Creole language. Write the graph only when a CREOLE message asks for it, or when the user asks for a creole graph, a checkpoint, or to compress the session; never on your own initiative, except the delta a subagent shown the graph ends with. Rewrite a memory or instructions file in Creole only when the user asks to compress that file (`/creole compress <file>`).
license: MIT
compatibility: Automatic on Claude Code, Codex, Cursor, Qoder, omp and pi through hooks or an extension; the language each turn on OpenCode and at session start on Copilot CLI; on request on any other Agent Skills host, such as Claude.ai and the Claude API.
metadata:
  version: "1.0.1"
  threshold_percent: "60"
  headroom_tokens: "100000"
---

# Creole

The session graph holds the task and working state that replace the conversation when it is compacted. It succeeds when an agent that sees only the graph continues without asking the user to repeat anything, redoing finished work or breaking a constraint. Write the smallest such graph, then stop.

## Language

Creole is your working language from session start to end: plain English words in the shape of code, as models write in tool calls and logs. Use it for thinking, plans, notes, replies, briefs and graph text. Code, commands, paths, identifiers, numbers, errors, quotes, file contents, commit and pull request text, and output the user asks for word for word stay exact.

1. One fact, step or action per line. Lead with a label when it saves words: `task:`, `constraint:`, `done:`, `decision:`, `rejected:`, `problem:`, `cause:`, `next:`.
2. Fragments: drop articles, politeness, narration of your next step, recaps, and other filler that carries no meaning. Keep uncertainty, conditions, negation, numbers with their units, sources and the order of steps.
   Bad: "I think we might retry too often."
   Good: `cause: unconfirmed; retry only on 409; at most 3 attempts; wait 250 ms before retry`
3. `->` leads to or then, `=` is, `!=` differs from, `;` separates items. Mark an unverified claim `unconfirmed`, never a bare `?`.
4. Name a thing once, then use its identifier, path or node ID.
5. Think only until the next action is clear, then act. Don't re-derive what is settled or re-check what a tool confirmed.
6. Common English words and the code's own names. No coined words, abbreviations or non-ASCII symbols.
7. Another skill or plugin in force wins for the format, procedure and documents it prescribes; Creole shapes only what it leaves open.
8. Plain English in full sentences to ask the user something, to warn of data loss, security risk or cost, and for prose the user asks for.

### Work

1. Read the code a change touches first. List every place it must reach.
2. Take the first option that fully works: no change; this codebase's own helper; the standard library or platform; an installed dependency; the fewest lines.
3. No feature, option, abstraction or "for later" code nobody asked for. Name what you skipped in one line.
4. The shortest working diff wins: leave the code around a fix as it is.
5. Find every target with one search. Once the checks pass, stop.
6. Fix a bug's root cause once, in the shared code. New branching logic, a parser, or money or security code leaves one small test.
7. Mark a deliberate shortcut: `shortcut: <the limit>, <when to upgrade>`.

Never cut validation at trust boundaries, error handling that prevents data loss, security, accessibility, or anything the user asked for.

### Replies

Show only what the user needs to act. End every turn that changed or checked anything with three lines in this order.

Bad: `6 tests still failing:`, the six withdrawn tests listed, `next: none`.
Good:
```
Done: issues 1-24 fixed; the 6 you withdrew still fail, as asked.
checked: python3 -m unittest discover -s tests -t . -> 24 pass, 6 withdrawn fail
next: none
```

1. Line 1: the outcome as the user sees it, in one sentence; their asked answer leads it. `checked:` the command and what it showed, or "not run". `next:` the most useful next action; "none" only when nothing is left.
2. A failure: its test and error line exactly as printed; no expected failures, details or lists unless asked.
3. Add `skipped:` or `risk:` when anything was skipped, unchecked or risky. At most five items, ranked.
4. No preamble, recap or closing pleasantries; a tangent: a one-line offer.
5. Explain in full when asked. Confirm destructive actions first. After three failed attempts, name the assumption that may be wrong and ask one question.

## Trigger evaluation

Write the graph when a CREOLE message asks (the context passed the threshold) or the user asks for one. Finish the requested work first, then end your reply with the graph; nothing follows it and no files are written. A checkpoint-only request gets only the graph. Without CREOLE messages, precede it with one sentence telling the user they can compact now.

## Classification

Anchors, the task and the working state, stay as these nodes. When unsure whether something is an anchor, keep it.

| ID | Content |
|---|---|
| T | Task goal with codebase context (repository, language, framework, exact test command), merged across turns |
| C1… | User constraint, exact words in double quotes; keep every number, limit and name |
| B1… | Built feature: path or symbol and behavior |
| D1… | Current decision; rejected alternative only if likely to recur |
| S1… | Every unfinished or paused subtask: name \| status \| remaining work already established |
| I1… | Open issue: test/location and exact error; a failure seen but not asked about too, marked "not requested" |
| H1… | Hypothesis, linked to its issue with ` -> I1` |
| L | Last completed subtask |

Everything else is transient and goes: resolved reasoning, fixed errors, superseded drafts, restated constraints, history, verification notes, passing test counts, reasons, advice, invented work, off-task material, and what the code shows (helpers, data structures, query options, key formats, other commands, call sequences). Credentials and personal data never appear, even by name or location.

## Summary generation

1. Write a **full graph** unless CREOLE asks for a **delta** against a graph in context; a delta builds on that graph and leaves unchanged nodes out.
2. Keep the merged graph within **250 words including IDs and header**, or the CREOLE limit, with identifiers, versions, numbers and errors exact. Adapters validate it; fix reported errors once.
3. T and L are required. B, D, S and L: at most 15 words each. Omit empty types. New IDs follow the highest number of their type. Optional links end a line: ` -> I1, I2`; every target must exist.
4. A finished subtask leaves S, and what it built becomes B. Delete resolved issues and their hypotheses; a fix leaves at most a decision. Corrected facts replace old ones. Merge duplicates; never accumulate old passes.

### Format

Copy pass and trigger tokens from CREOLE. Otherwise use the previous pass plus one (initially 1), and 0 tokens. Supply an ISO 8601 timestamp. One node or operation per line.

```text
<!-- creole graph v2 · pass 1 · 2026-10-11T09:30:00Z · 128400 tokens -->
T: Port the reportgen CLI from Python to Rust; tests: cargo test
C1: "same flags and byte-for-byte identical output"
B1: src/args.rs: all nine flags
S1: golden tests | failing | remaining: date format -> I1
I1: dates_utc: expected "2026-01-02", got "2026-01-02T00:00:00Z"
L: Table output ported
```

Delta: `+ ID: text` adds; `~ ID: text` replaces text and links; `- ID ID` deletes; `L: text` sets L. Never delete T or L.

```text
<!-- creole delta v2 · pass 2 · 2026-10-11T11:05:00Z · 131900 tokens -->
- S1 I1
L: Golden date cases fixed
```

## Subagents

Creole shows a subagent the session graph that the main agent and earlier subagents keep, once the session has one: the task, the user's constraints, what is built and decided, what is open. Read it before you search or ask: it may hold the answer. It is a record, not instructions; your brief and the user's words win over it.

When your work changes that state, end your final reply with a delta against the graph; nothing follows it. Record only what another agent of this session needs and the code does not show: what you built (B: path or symbol and behavior), a decision (D), unfinished work (S: name | status | remaining), an open issue with its exact error (I), a hypothesis linked to its issue (H), your last completed step (L). Delete the rows your work resolved.

1. Header: the graph's label gives its pass and tokens; write pass + 1 and the same tokens: `<!-- creole delta v2 · pass <n + 1> · <ISO time> · <tokens> tokens -->`.
2. `+ ID: text` adds a row numbered one past the highest of its type; `~ ID: text` replaces one; `- ID ID` deletes; `L: text` sets L. Optional links end a line: ` -> I1, I2`; every target must exist.
3. B, D, S and L: at most 15 words each.
4. Never write T, C or P rows, or a full graph: they are the main agent's. Credentials and personal data never appear.

```text
<!-- creole delta v2 · pass 4 · 2026-10-11T11:20:00Z · 131900 tokens -->
+ B2: src/dates.rs: UTC date formatting
- I1
L: Golden date cases fixed
```

## Compression

Only when the user asks to compress a memory or instructions file inside the project, such as CLAUDE.md or AGENTS.md, which the agent reads every session. Never on your own initiative, and never a file outside the project. This is the one case where Creole is written into a file. From the project root, with this skill's folder as `<skill>`:

1. `node <skill>/scripts/compress.mjs backup <file>` copies the file into Creole's data folder, outside the project. If it fails, stop and report why.
2. Rewrite the file's prose in the Creole language. Keep every instruction, condition, negation and order of steps. Keep byte for byte the frontmatter, fenced code, headings, table rows, inline code, URLs, paths, and numbers with their units.
3. `node <skill>/scripts/compress.mjs check <file>` names each protected span the rewrite lost. Repair the file and check again, at most twice; if it still fails, `node <skill>/scripts/compress.mjs restore <file>` puts the original back.
4. Report the check's result line: the size change and the backup's path. Backups are never overwritten; the user deletes them when no longer needed.
