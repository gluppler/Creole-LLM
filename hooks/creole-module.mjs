// Creole for Claude Code's function hooks (2.1.287+): Creole compacts the session itself, with no
// help from the agent and without the engine's summarizer.
//
//   prompt.compose    append the Creole language (SKILL.md's Language section) to every system prompt
//   prompt.context    open each conversation, and again after each compaction, with the project block:
//                     the codebase map (hooks/creole-scan.mjs, a process of its own), labeled as a record
//                     and not instructions
//   prompt.attachment drop the copies the SessionStart command hook adds before the module is running
//   prompt.submit     keep each of the user's messages in the plugin's store, redacted
//   session.measure   track the base context; move the engine's auto-compaction (which also runs
//                     mid-turn) to Creole's limit, unless the user configured auto-compaction
//   agent.spawn       give a subagent the session graph, once there is one, with the skill's Subagents section
//   turn.complete     a subagent given the graph: merge the delta its answer ends with into the stored
//                     graph; the main loop past the limit between turns: compact
//   session.compact   a fork over the cached transcript writes the session graph (a delta against the
//                     graph stored for this session, shown in its prompt); the user's messages,
//                     whole, and the graph then replace the whole conversation. The fork reads
//                     SKILL.md without its Language section, which the prompt carries when on. If the
//                     skill is unreadable, the fork fails, the graph is still invalid after one retry,
//                     or the messages and graph exceed the budget, the engine compacts instead, told
//                     to keep the user's instructions. One runs at a time; one whose conversation or
//                     graph changed while the fork ran (new input, a subagent's merge, /clear, another
//                     model or window) is skipped.
//   session.append    count the conversation's new input; the engine keeping Creole's replacement is
//                     the compaction's observed end, which alone is logged as done; after a compaction,
//                     a main response below the limit re-arms it
//   session.end       mark the session's record ended, so it can expire 30 days on
//
// CREOLE_CHECKPOINT=natural or proposal has the fork write that checkpoint
// instead of the graph (checkpointContext); nothing is stored or shared for it.
//
// The session graph is the session's wiki: the main agent's compactions and its subagents' deltas build
// one graph in the session's record. Nothing of it crosses sessions or projects; the records earlier
// versions kept (store keys wiki-v4:* and profile-v1) are neither read nor changed. CREOLE_WIKI=off: no
// map, share or merge.
//
// It sets CREOLE_MODULE=1 for every process Claude Code starts, so the command hooks stand down.
// Hosts without function hooks ignore this file and run the command hooks alone.

import {
  applyUpdate,
  checkCheckpoint,
  checkGraph,
  checkpointContext,
  config,
  emptyGraph,
  escapeDelimiters,
  extractUpdate,
  graphSkill,
  IDLE_MS,
  languageContext,
  MAP_CHARS,
  MAX_ALL_BYTES,
  MAX_SESSION_BYTES,
  mergeDelta,
  projectContext,
  redactSecrets,
  renderGraph,
  replayBudget,
  settingsNotice,
  skillMetadata,
  skillNotice,
  skillsInForce,
  subagentContext,
  triggerLimit,
  utf8Length,
  wordCount,
} from '../lib/creole-graph.mjs';

// Claude Code 2.1.287 compacts at its window minus a 20k output reserve and a 13k buffer, and
// takes no window below 100k from CLAUDE_CODE_AUTO_COMPACT_WINDOW; under that, 2.1.292's
// CLAUDE_AUTOCOMPACT_PCT_OVERRIDE lowers its limit to that percentage of the window less the output
// reserve. Version-specific, not portable.
const ENGINE_OUTPUT = 20000;
const ENGINE_RESERVE = ENGINE_OUTPUT + 13000;
const ENGINE_MIN_WINDOW = 100000;
// Rows that change what a compaction's fork summarized: the conversation's new input and output.
const INPUT_DOORS = new Set(['prompt', 'response', 'tool-result', 'tool-message', 'delivery']);
// Compactions this close together (in responses) mean the agent re-reads more than the headroom
// frees, so the headroom grows by half each time; three times this far apart, it shrinks back.
const THRASH_RESPONSES = 8;
// The user's own words: typed or queued at the terminal, sent through Remote Control, or a -p turn.
const HUMAN = new Set(['composer', 'bridge', 'sdk']);
// Room a record's messages and graph leave for its markers (gap, ended), which are never refused.
const MARKER_BYTES = 64;
// The scan's own limit is a second; this leaves time for starting Node.
const SCAN_MS = 3000;
// The project block's name among the context blocks (rendered as its heading), and the SessionStart
// command hook's copy, which escapeDelimiters keeps quoted text from closing early.
const PROJECT_NAME = 'creoleProject';
const PROJECT_BLOCK = /<creole-project>\n[\s\S]*?\n<\/creole-project>/g;

// The messages after the main thread's last request: the reply to it, and what followed. A tool's
// input and output are whole, since its decisive line can come last; a later output for the same
// call shows if it differs.
export function newestMessages(messages) {
  let i = messages.length;
  while (i > 0 && messages[i - 1].role === 'user') i--;
  while (i > 0 && messages[i - 1].role === 'assistant') i--;
  const parts = [];
  const shown = new Map();
  for (const m of messages.slice(i)) {
    if (m.text?.trim()) parts.push(`${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text.trim()}`);
    for (const u of m.toolUses ?? []) {
      const out = u.text === undefined ? '' : `${u.isError ? 'error: ' : ''}${u.text}`;
      if (u.text !== undefined) shown.set(u.tool_use_id, out);
      parts.push(`Tool ${u.tool} ${JSON.stringify(u.input ?? {})}${u.text === undefined ? '' : ` -> ${out}`}`);
    }
    for (const r of m.toolResults ?? []) {
      const out = `${r.isError ? 'error: ' : ''}${r.text ?? ''}`;
      if (shown.get(r.tool_use_id) !== out) parts.push(`Tool result: ${out}`);
      shown.set(r.tool_use_id, out);
    }
  }
  return parts.join('\n');
}

// checkpoint: config's form. natural reads only the skill's Classification; proposal, no skill, as the
// proposal's own instructions (section 3.4, its edge cases in 3.5). base: the graph Creole stored for the
// session, which a delta builds on, shown whole: the conversation may not open with it (a subagent's delta
// merged since, or the engine's summary in its place).
export function forkPrompt({ checkpoint = 'graph', skill, base, time, tokens, maxWords, newest, instructions }) {
  const form = base.pass ? `a creole delta against the stored pass ${base.pass} graph above` : 'the full creole graph';
  const ask = {
    graph: `Reply with only ${form} (pass ${base.pass + 1}, time ${time}, tokens at trigger ${tokens}; the graph stays within ${maxWords} words), as the creole skill above specifies. Write it straight from the conversation: no planning or drafting first.`,
    natural: `Reply with only a checkpoint of its task and working state in plain prose, within ${maxWords} words: keep what the classification above keeps and drop what it calls transient, with no node IDs or graph lines.`,
    proposal: `Split the conversation into anchors and transient content. The anchors are the original task and the current working state; the user's first message is kept for you, so do not copy it. Replace everything else with a structured summary of at most ${maxWords} words, in exactly these three parts:\nTask: the task restated concisely: its goal, codebase context and explicit constraints.\nWorking state: what has been built and decided so far, every active subtask with its status, and any unresolved issue.\nLast completed: one line on the most recently completed subtask.\nIf the conversation opens with an earlier summary, fold it into this one rather than drop it. Keep only what lets the work continue; nothing extra.`,
  }[checkpoint];
  return [
    checkpoint !== 'proposal' &&
      `<creole-skill>\n${checkpoint === 'natural' ? CLASSIFICATION.exec(skill)[0].trim() : skill}\n</creole-skill>`,
    newest && `Your context above ends before these newest messages:\n<newest>\n${escapeDelimiters(newest)}\n</newest>`,
    instructions && `The user's instructions for this compaction: ${instructions}`,
    checkpoint === 'graph' &&
      base.pass &&
      `The session graph Creole stored, which the delta builds on:\n\n${renderGraph(base)}`,
    `CREOLE: this conversation is being compacted, and your reply replaces all of it. Do not use tools. ${ask}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}
const CLASSIFICATION = /\n## Classification\n[\s\S]*?(?=\n## |$)/;

function limitOf(s) {
  return triggerLimit({ window: s.window, threshold: s.cfg.threshold, floor: s.floor, headroom: s.headroom });
}

// Another window or model has another base, so the smallest context seen no longer stands, nor does
// a headroom grown for the last one (unless the user set it).
function rebase(s, window, model) {
  if ((s.window && window && window !== s.window) || (s.model && model && model !== s.model)) {
    s.floor = Infinity;
    if (!s.cfg.fixedHeadroom) s.headroom = s.cfg.headroom;
  }
  if (window) s.window = window;
  if (model) s.model = model;
}

// The engine reads this on every check, so it also compacts long turns at Creole's limit. Disarmed
// (a compaction left the conversation above the limit), the engine keeps its own limit meanwhile.
// (Claude Code only lets `$` reach functions declared at the top of the module.)
async function retarget($, s) {
  if (!s.ownsEngine || !s.window) return;
  const limit = Math.round(limitOf(s));
  const on = s.armed && limit + ENGINE_RESERVE < s.window;
  const value = on ? String(Math.max(ENGINE_MIN_WINDOW, limit + ENGINE_RESERVE)) : undefined;
  // Under the minimum window the engine would wait for 67k; its percentage brings it down to Creole's
  // limit, which a -p session needs (Claude Code 2.1.292 never ran the compaction turn.complete asks for there).
  const pct =
    on && limit + ENGINE_RESERVE < ENGINE_MIN_WINDOW
      ? String((limit * 100) / (ENGINE_MIN_WINDOW - ENGINE_OUTPUT))
      : undefined;
  await $.env.set('CLAUDE_CODE_AUTO_COMPACT_WINDOW', value);
  await $.env.set('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE', pct);
  // Marks the values as Creole's, so a reloaded module doesn't mistake them for the user's.
  await $.env.set('CREOLE_ENGINE_WINDOW', value);
  await $.env.set('CREOLE_ENGINE_PCT', pct);
}

// The session's record in the plugin's store: the user's messages, redacted, the graph Creole last
// compacted to, gap once a message could not be kept, unverified while the host could not yet count
// the conversation's turns, and ended once the session ends. It outlives hot reloads and resumes; /clear
// starts a new session id, so a new record. {} before the first message; null when this version
// cannot use it (another version's, damaged, over the cap), and it is then neither restored nor
// overwritten. The host decodes it before this check, so the cap is enforced after the read.
async function sessionRecord($, sid) {
  const r = await $.store.get(`user:${sid}`);
  if (r === undefined) return {};
  return usable(r) ? r : null;
}

const usable = (r) =>
  r &&
  typeof r === 'object' &&
  !Array.isArray(r) &&
  r.v === undefined &&
  (r.texts === undefined || (Array.isArray(r.texts) && r.texts.every((t) => typeof t === 'string'))) &&
  utf8Length(JSON.stringify(r)) <= MAX_SESSION_BYTES;

// A record's bytes in the store, its key included.
const sizeOf = (key, r) => utf8Length(JSON.stringify({ [key]: r }));

// The user's messages in a record, redacted again: an older version's patterns missed some credentials.
const textsOf = (record) => (record.texts ?? []).map(redactSecrets);

// Whether this process saw the session's record, now gone (another session's cleanup, a deletion).
const went = (s, sid, r) => !Object.keys(r).length && s.sizes.has(`user:${sid}`);

// Whether the conversation holds user turns Creole never kept (a resume after the record expired, an
// in-session /resume, Creole loaded mid-session), asked of a record that is empty or unverified. Asked
// before a prompt enters, so a new session counts 0. null until the host binds the session (session
// start, a prompt given on the command line): turns() then answers 0, even for a resumed conversation.
// shortcut: turns() may count user-role messages that are not the user's (unconfirmed which), so a verified record is
// not asked again; 06 should check how often an unverified one is flagged falsely.
async function missing($, r) {
  if (Object.keys(r).length && !r.unverified) return false;
  if (
    !(await $.session.messages().then(
      () => true,
      () => false,
    ))
  )
    return null;
  return (await $.session.turns()) > (r.texts?.length ?? 0);
}

// Changes the session's record, one change at a time: handlers overlap, and each would otherwise
// write back a copy missing the other's message. change(record) gives the fields to set, or null to
// leave it; any change but the end's takes the end mark off. A capped change (a message, a graph)
// leaves the markers their room and keeps every session's records within 3 MiB; a marker is never
// refused room. Resolves to why the record could not be changed, or null. A gap held in memory goes
// on record with the change.
// shortcut: the queue orders this process only; the host locks each set, but two processes on one session can still
// drop a message.
function changeRecord($, s, sid, change, capped = false) {
  const key = `user:${sid}`;
  const run = async () => {
    try {
      const r = await sessionRecord($, sid);
      if (!r) return 'this version cannot use the stored record';
      if (went(s, sid, r)) s.gaps.add(sid);
      const fields = await change(r);
      if (!fields) return null;
      const next = { ...r, ended: undefined, ...fields, time: await $.clock.now() };
      if (s.gaps.has(sid)) next.gap ??= next.time;
      for (const k in next) if (next[k] === undefined) delete next[k];
      const size = sizeOf(key, next);
      if (size > MAX_SESSION_BYTES - (capped ? MARKER_BYTES : 0))
        return `the record would pass its ${MAX_SESSION_BYTES / 1024} KiB cap`;
      if (capped && [...s.sizes].reduce((n, [k, b]) => (k === key ? n : n + b), size) > MAX_ALL_BYTES)
        return `all sessions' records would pass ${MAX_ALL_BYTES / 1048576} MiB`;
      await $.store.set(key, next);
      s.sizes.set(key, size);
      return null;
    } catch {
      return 'the plugin store failed'; // the host's message can quote stored text, so it isn't repeated
    }
  };
  return (s.queue = s.queue.then(run, run));
}

// Keeps one of the user's messages, whole or not at all. One Creole cannot keep is reported, and the
// gap goes on record (in memory until the store takes it), so no compaction calls the messages complete.
// One kept before the host can count the conversation's turns is unverified until it can.
async function remember($, s, text) {
  const sid = await $.session.id(); // the prompt's session, though a /clear may follow before the write
  const why = await changeRecord(
    $,
    s,
    sid,
    async (r) => {
      const lost = await missing($, r).catch(() => null);
      if (lost) s.gaps.add(sid);
      return { texts: [...textsOf(r), redactSecrets(text)], unverified: lost === null || undefined };
    },
    true,
  );
  if (!why) return;
  s.gaps.add(sid);
  await changeRecord($, s, sid, () => ({}));
  $.ui.log(
    `Creole could not keep this message (${why}), so the next compaction may lose it; restate it then if it still matters.`,
  );
}

// Why a record cannot replace the conversation, or null: this version cannot read it, a message is
// missing from it, or its messages fill the budget and leave no room for a graph.
function declined(record, s, sid, budget) {
  if (!record) return { reason: 'unavailable' };
  if (record.gap || s.gaps.has(sid)) return { reason: 'incomplete' };
  return checkpointContext(s.cfg.checkpoint, '', textsOf(record), budget) ? null : { reason: 'overflow' };
}

// Session start: removes other sessions' records that ended and were then untouched for 30 days, if
// this version can read them, and notes the size of the rest; no record goes to make room. Age alone
// proves nothing: a session that never ended may still run, or was killed. This session's end mark
// comes off (a resume), so no other session's cleanup takes it.
// shortcut: one whole-store read per record (the host reads its file for every call), and other sessions' growth after
// this start goes uncounted; keep a ledger of times and sizes if starts slow.
async function sweep($, s, sid) {
  const now = await $.clock.now();
  for (const k of await $.store.keys()) {
    if (!k.startsWith('user:')) continue;
    const r = await $.store.get(k);
    if (k !== `user:${sid}` && usable(r) && r.ended && now - r.time > IDLE_MS) await $.store.delete(k);
    else s.sizes.set(k, sizeOf(k, r));
    if (k === `user:${sid}` && r?.ended) await changeRecord($, s, sid, () => ({}));
  }
}

// The codebase map, from hooks/creole-scan.mjs, run as a process of its own (this environment has no
// Node); '' when it cannot run or answers out of shape.
async function scan($, root) {
  const r = await $.process
    .run(['node', `${$.plugin.root}/hooks/creole-scan.mjs`, root], { timeoutMs: SCAN_MS })
    .catch(() => null);
  if (r?.exitCode !== 0) return '';
  try {
    const { map } = JSON.parse(r.stdout);
    return typeof map === 'string' && map.length <= MAP_CHARS ? map : '';
  } catch {
    return '';
  }
}

// A subagent Creole gave the graph ended a turn: the delta its answer ends with merges into the stored graph
// (mergeDelta) in the record's queue, and a merge makes a compaction in flight stale (s.rev). No retry: a
// delta with errors is dropped and one written against a graph since replaced ignored, each logged.
async function merge($, s, e) {
  const update = extractUpdate(e.answer);
  if (!update) return;
  const sid = await $.session.id();
  let r = null;
  const why = await changeRecord(
    $,
    s,
    sid,
    (record) => {
      r = mergeDelta(checkGraph(record.graph), update);
      if (r.ignored || r.errors.length) return null;
      s.rev++;
      return { graph: r.graph };
    },
    true,
  );
  const outcome = why
    ? { unstored: why }
    : r?.ignored
      ? { ignored: true }
      : r?.errors.length
        ? { errors: r.errors }
        : { pass: r?.graph.pass };
  $.ui.log(`creole-merge ${JSON.stringify({ agent: e.agentId, ...outcome })}`, { to: 'debug' });
}

// The engine kept the replacement Creole issued: the compaction is done. Compactions close together
// mean the agent re-reads more than the headroom frees, so unless the user set the headroom it grows by
// half, up to what the share of the window leaves above the base (more moves no limit; nothing while
// either is unknown); three times as far apart, it shrinks back toward the configured one.
async function committed($, s) {
  const { what, words, log } = s.issued;
  s.issued = null;
  // The size before is the host's measure when Creole forked; an unknown one is not shown.
  const size = log.ctx == null ? '' : ` (${log.ctx.toLocaleString('en-US')} tokens)`;
  $.ui.log(`Creole compacted the conversation${size} into ${what} (${words} words).`);
  // One line per compaction for experiments: what the forks cost and where the rate limits stand.
  $.ui.log(`creole-compaction ${JSON.stringify({ ...log, rateLimits: (await $.session.usage()).rateLimits })}`, {
    to: 'debug',
  });
  const headroom = s.headroom;
  const cap = Math.max(s.cfg.headroom, s.window ? (s.window * s.cfg.threshold) / 100 - s.floor : 0);
  if (s.cfg.fixedHeadroom) {
    /* the user's headroom stays as set */
  } else if (s.sinceCompact < THRASH_RESPONSES) s.headroom = Math.min(Math.round(s.headroom * 1.5), Math.round(cap));
  else if (Number.isFinite(s.sinceCompact) && s.sinceCompact >= 3 * THRASH_RESPONSES)
    s.headroom = Math.max(s.cfg.headroom, Math.round(s.headroom / 1.5));
  if (s.headroom !== headroom) await retarget($, s);
  s.sinceCompact = 0;
}

// One compaction, from the fork to the replacement or the engine's own compaction. It runs over
// e.messages and the stored graph; input arriving meanwhile, a subagent's merge, a /clear, or another
// model or window makes its graph stale, and a stale graph replaces nothing and is not stored.
async function compact($, s, e, next) {
  const rev = s.rev; // read before any wait: the input e.messages holds
  const sid = await $.session.id(); // the compacted session, though a /clear may follow during the fork
  s.skill ??= graphSkill(await $.fs.read(`${$.plugin.root}/skills/creole/SKILL.md`).catch(() => '')) || null;
  const record = await sessionRecord($, sid).catch(() => null);
  // A record that went while the session ran, or user turns Creole never kept or cannot count yet.
  if (record && (went(s, sid, record) || ((await missing($, record).catch(() => null)) ?? true))) s.gaps.add(sid);
  // The graph Creole stored for the session, its subagents' merges included: the delta builds on it.
  const base = checkGraph(record?.graph) ?? emptyGraph();
  const { context } = await $.session.usage();
  const model = await $.session.model().catch(() => null);
  const stale = async () =>
    s.rev !== rev ||
    (await $.session.id().catch(() => null)) !== sid ||
    (await $.session.model().catch(() => null)) !== model ||
    (await $.session.usage().catch(() => null))?.context.window !== context.window;
  const dropped = () => {
    $.ui.log(`creole-stale ${JSON.stringify({ trigger: e.trigger, ctx: context.tokens ?? null })}`, { to: 'debug' });
    return {
      skip: 'The conversation changed while Creole wrote its graph, so it stays as it is; Creole compacts it again at its limit.',
    };
  };
  const { checkpoint } = s.cfg;
  const graphed = checkpoint === 'graph';
  // The graph header needs a number; an unknown count goes as 0 there and as null in the logs.
  let prompt = forkPrompt({
    checkpoint,
    skill: s.skill,
    base,
    time: new Date(await $.clock.now()).toISOString(),
    tokens: context.tokens ?? 0,
    maxWords: s.cfg.maxWords,
    newest: newestMessages(e.messages),
    instructions: e.instructions,
  });
  const spent = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  // Half the room below Creole's limit (replayBudget), so the replacement lands well under it.
  const budget = replayBudget({ window: s.window || s.cfg.window, threshold: s.cfg.threshold, floor: s.floor, headroom: s.headroom });
  // A record that cannot replace the conversation (unreadable, missing a message, or too long to
  // leave room for any graph), or no skill to write the graph from, means no fork is paid for.
  let why = s.skill ? declined(record, s, sid, budget) : { reason: 'skill-unavailable' };
  let kept = null; // a valid graph the replacement had no room for
  if (!why)
    for (let attempt = 0; attempt < 2; attempt++) {
      // The fork reads the conversation, then this prompt, and answers within the engine's reserve.
      // shortcut: 4 characters a token is an estimate; an overflow it misses fails as an API error and falls back.
      if (context.tokens + prompt.length / 4 + ENGINE_RESERVE > context.window) {
        why = { reason: 'fork-overflow' };
        break;
      }
      let reply;
      try {
        reply = await $.model.fork({ prompt });
      } catch (error) {
        // Its message can quote the request, so only the status is kept.
        why = { reason: 'fork-error', status: error?.status };
        break;
      }
      for (const k in spent) spent[k] += reply.usage?.[k] ?? 0;
      // Before the first response (a resume, /clear) there is nothing to fork: if the conversation
      // fits, let the turn run and compact after it, rather than lose the graph to the engine's summary.
      if (reply.reason === 'nothing-to-fork' && e.trigger !== 'manual') {
        // A resumed session may have no breakdown yet; its last response's size stands in.
        const b = (await $.session.usage({ breakdown: 'summary' }).catch(() => null))?.context.breakdown;
        if ((b?.totalTokens ?? context.tokens) + ENGINE_RESERVE < context.window)
          return { skip: 'Creole compacts after the first response, when the conversation can be forked.' };
      }
      if (!reply.isAnswered) {
        why = { reason: reply.reason, status: reply.status };
        break;
      }
      const update = graphed ? extractUpdate(reply.text) : null;
      const {
        graph,
        text: written,
        errors,
        tooLong,
      } = graphed ? applyUpdate(base, update, s.cfg.maxWords) : checkCheckpoint(checkpoint, reply.text, s.cfg.maxWords);
      // On the retry, a graph whose only problem is length is kept: long beats lost.
      if (!errors.length || (tooLong && attempt === 1)) {
        if (await stale()) return dropped();
        const rendered = graphed ? renderGraph(graph) : written;
        // Stored either way: the conversation opens with it next time, or the engine's summary carries it.
        // A record that reached the fork has every turn the host counts, so it is no longer unverified.
        // A checkpoint form stores nothing: each compaction writes its checkpoint whole. A subagent's merge
        // since the record was read (s.rev, in the same queue) stands, and this graph, stale, is not stored.
        const unstored = await changeRecord(
          $,
          s,
          sid,
          () => (s.rev !== rev ? null : graphed ? { graph, unverified: undefined } : { unverified: undefined }),
          true,
        );
        if (unstored && graphed)
          $.ui.log(
            `Creole could not store the session graph (${unstored}), so the next compaction writes a full graph.`,
          );
        // Read again: a message lost meanwhile stops the replacement.
        const now = await sessionRecord($, sid).catch(() => null);
        why = declined(now, s, sid, budget);
        const text =
          !why &&
          checkpointContext(
            checkpoint,
            rendered,
            textsOf(now),
            budget,
            e.trigger === 'auto',
            skillsInForce(e.messages),
          );
        if (!text) {
          why ??= { reason: 'overflow' };
          kept = rendered;
          break;
        }
        if (await stale()) return dropped();
        // Issued, not done: the engine keeping it (session.append) ends the compaction. Until usage is
        // seen below the limit, Creole starts no other and the engine keeps its own limit.
        const fork = {
          in: spent.input_tokens,
          out: spent.output_tokens,
          cr: spent.cache_read_input_tokens,
          cw: spent.cache_creation_input_tokens,
        };
        const words = wordCount(rendered);
        s.issued = {
          rendered,
          words,
          what: graphed ? `the pass ${graph.pass} session graph` : `a ${checkpoint} checkpoint`,
          log: {
            ...(graphed ? { pass: graph.pass } : { checkpoint }),
            trigger: e.trigger,
            ctx: context.tokens ?? null,
            words,
            attempts: attempt + 1,
            fork,
          },
        };
        $.ui.log(`creole-issued ${JSON.stringify(s.issued.log)}`, { to: 'debug' });
        await disarm($, s);
        return { messages: [{ role: 'user', text, toolUses: [] }] };
      }
      why = { reason: graphed ? 'invalid-graph' : 'invalid-checkpoint', errors };
      $.ui.log(`Creole graph attempt ${attempt + 1} rejected: ${errors.join(' ')}`, { to: 'debug' });
      prompt += `\n\nYour reply was:\n${redactSecrets(String(reply.text))}\n\nIt needs fixing:\n- ${errors.join('\n- ')}\nReply with only the corrected ${graphed ? (update?.kind ?? 'graph') : 'checkpoint'}.`;
    }
  const failed =
    {
      overflow: "fit the user's messages and the graph in its budget",
      incomplete: "keep every one of the user's messages",
      unavailable: "read the user's messages it stored",
      'fork-overflow': "fit the newest messages in the fork's context",
      'skill-unavailable': 'read its skill',
    }[why.reason] ?? (graphed ? 'write the session graph' : `write its ${checkpoint} checkpoint`);
  $.ui.log(
    `Creole could not ${failed} (${why.reason}${why.status ? ` ${why.status}` : ''}), so Claude Code compacts instead.`,
  );
  // The engine's summary is not Creole's retention: whatever it drops is lost.
  $.ui.log(
    `creole-fallback ${JSON.stringify({ trigger: e.trigger, ctx: context.tokens ?? null, ...why, retention: 'degraded' })}`,
    { to: 'debug' },
  );
  await disarm($, s);
  // The engine's summary keeps what Creole could not: the user's active instructions, and the graph when one was
  // written.
  const keep = [
    e.instructions,
    "Keep every instruction of the user's that is still active, in their exact words where possible.",
    kept && `Copy this ${graphed ? 'session graph' : 'checkpoint'} into the summary unchanged:\n\n${kept}`,
  ];
  return next({ ...e, instructions: keep.filter(Boolean).join('\n\n') });
}

// After a compaction, Creole compacts again only once usage is seen below its limit (session.measure,
// or a main response meanwhile): one that left the conversation above it would otherwise repeat at every turn.
async function disarm($, s) {
  s.armed = false;
  s.reported = false;
  await retarget($, s);
}

export const register = (on, options = {}) => {
  const s = {
    cfg: config({}),
    headroom: 0, // the configured headroom, grown by backoff
    floor: Infinity, // smallest context seen: system prompt, tools, restored graph
    window: null, // the model's context window, from the last measurement
    sinceCompact: Infinity, // responses since Creole last compacted
    autoCompact: true, // the user's auto-compaction switch
    ownsEngine: false, // whether Creole may move the engine's auto-compaction point
    skill: null, // SKILL.md's graph instructions for the fork, without its Language section (graphSkill)
    skillText: '', // SKILL.md whole, whose Subagents section comes with a shared graph
    language: '', // the system prompt section that teaches the Creole language ('' when off)
    model: null, // the main loop's model, whose change rebases the trigger
    root: null, // the project root the codebase map is of (null when the wiki is off)
    shared: new Set(), // the subagents given the session graph, whose answers merge
    queue: Promise.resolve(), // the record changes in flight, in order
    gaps: new Set(), // sessions with a message Creole could not keep
    sizes: new Map(), // each session record's bytes, as of session start or this module's last write
    armed: true, // whether Creole compacts at its limit: not from a compaction until usage is seen below it
    reported: false, // whether a compaction that left the conversation above the limit was reported
    rev: 0, // the conversation's input so far (prompts, responses, tool results, deliveries), counted
    busy: false, // a compaction in flight
    issued: null, // the replacement handed to the engine, until the engine is seen keeping it
  };
  s.headroom = s.cfg.headroom;

  on('session.start', async ($, e, next) => {
    await $.env.set('CREOLE_MODULE', '1');
    const skill = await $.fs.read(`${$.plugin.root}/skills/creole/SKILL.md`).catch(() => '');
    s.skill = graphSkill(skill) || null;
    s.skillText = skill;
    const env = {
      CREOLE_THRESHOLD_PERCENT: await $.env.get('CREOLE_THRESHOLD_PERCENT'),
      CREOLE_HEADROOM_TOKENS: await $.env.get('CREOLE_HEADROOM_TOKENS'),
      CREOLE_MAX_WORDS: await $.env.get('CREOLE_MAX_WORDS'),
      CREOLE_LANGUAGE: await $.env.get('CREOLE_LANGUAGE'),
      CREOLE_WIKI: await $.env.get('CREOLE_WIKI'),
      CREOLE_CHECKPOINT: await $.env.get('CREOLE_CHECKPOINT'),
      CLAUDE_PLUGIN_OPTION_THRESHOLD_PERCENT: options.threshold_percent,
      CLAUDE_PLUGIN_OPTION_HEADROOM_TOKENS: options.headroom_tokens,
    };
    s.cfg = config(env, skillMetadata(skill));
    s.headroom = s.cfg.headroom;
    const settings = settingsNotice(s.cfg);
    if (settings) $.ui.log(settings);
    if (s.cfg.checkpoint !== 'graph')
      $.ui.log(
        `Creole writes a ${s.cfg.checkpoint} checkpoint instead of the session graph at each compaction (CREOLE_CHECKPOINT, for experiments).`,
      );
    s.model = await $.session.model().catch(() => null);
    const root = s.cfg.wiki ? await $.session.root().catch(() => null) : null;
    s.root = typeof root === 'string' && root ? root : null;
    const sid = await $.session.id().catch(() => null);
    await sweep($, s, sid).catch(() => {});
    // Set before the usage call below, which may compose the system prompt. Read once per process:
    // CREOLE_LANGUAGE changes nothing in a running session, whose prompt the host has cached.
    s.language = s.cfg.language ? languageContext(skill) : '';
    const notice = skillNotice(skill, s.cfg.language);
    if (notice) $.ui.log(notice);
    // An auto-compaction window or percentage the user set wins over Creole's, as does a settings
    // window or auto-compaction turned off.
    const window = await $.env.get('CLAUDE_CODE_AUTO_COMPACT_WINDOW');
    const pct = await $.env.get('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE');
    const userEnv =
      (window && window !== (await $.env.get('CREOLE_ENGINE_WINDOW'))) ||
      (pct && pct !== (await $.env.get('CREOLE_ENGINE_PCT')));
    const usage = await $.session.usage({ breakdown: 'summary' }).catch(() => null);
    const b = usage?.context.breakdown;
    s.autoCompact = b?.isAutoCompactEnabled !== false;
    s.ownsEngine = !userEnv && s.autoCompact && b?.autocompactSource !== 'settings';
    if (!s.ownsEngine)
      $.ui.log(
        s.autoCompact
          ? 'Creole leaves the timing of automatic compaction to your Claude Code settings; it still writes the session graph whenever the conversation compacts.'
          : 'Auto-compaction is off, so Creole compacts only when you run /compact.',
      );
    // Move the engine before the first request: the first reply can read enough files to cross the
    // limit before any measurement arrives. The engine's estimate of everything but the conversation
    // (system prompt, tools, skills, memory) stands in for the base until a response reports one;
    // a module loaded mid-session would otherwise take the whole conversation as its base.
    s.window = usage?.context.window ?? null;
    const base = (b?.categories ?? [])
      .filter((c) => c.kind === 'used' && c.name !== 'Messages')
      .reduce((n, c) => n + c.tokens, 0);
    if (base > 0) s.floor = Math.min(s.floor, base);
    await retarget($, s);
    return next(e);
  });

  // A plugin's own section is appended as `session`, after the engine's shared ones, so the shared
  // prompt cache still holds. Forks reuse the prompt, so the graph is written in Creole too. A section
  // with Creole's id already there is replaced, never doubled.
  on('prompt.compose', async ($, e, next) => {
    const result = await next(e);
    if (!s.language) return result;
    return {
      ...result,
      sections: [
        ...result.sections.filter((x) => x.id !== 'creole:language'),
        { id: 'creole:language', text: s.language, scope: 'session' },
      ],
    };
  });

  // Each conversation opens with the project block (the codebase map) as its own context block, and so
  // again after each compaction, when the engine reads the context anew.
  on('prompt.context', async ($, e, next) => {
    const result = await next(e);
    const block = s.root ? projectContext(await scan($, s.root)) : '';
    if (!block) return result;
    return {
      ...result,
      blocks: [...result.blocks.filter((b) => b.name !== PROJECT_NAME), { name: PROJECT_NAME, text: block }],
    };
  });

  // The SessionStart command hook runs before session.start sets CREOLE_MODULE, so on startup and
  // resume it teaches the language and adds the project block too, which prompt.context gives here.
  // Every plugin's SessionStart context shares one attachment, so only Creole's text goes. A subagent's
  // prompt lacks the language section, so its SubagentStart copy stays.
  // shortcut: alone there, it leaves the engine's 37-character framing line; matching that prose risks other plugins'
  // context.
  on('prompt.attachment', async ($, e, next) => {
    const result = await next(e);
    if (e.origin?.kind !== 'hook' || e.origin.event !== 'SessionStart' || typeof result.text !== 'string')
      return result;
    const text = (s.language ? result.text.replaceAll(s.language, '') : result.text).replace(PROJECT_BLOCK, '');
    return text === result.text ? result : { text: text.trim() || null };
  });

  // Stored before the prompt enters: a compaction at the start of its turn must already find it.
  // A prompt is new input: a compaction in flight no longer covers the conversation.
  on('prompt.submit', async ($, e, next) => {
    s.rev++;
    if (HUMAN.has(e.origin?.kind) && e.text.trim()) await remember($, s, e.text).catch(() => {});
    return next(e);
  });

  // A subagent starts with the session graph, once there is one, and the skill's Subagents section
  // (subagentContext), after its brief: the spawn's prompt is the one context the module can give it. Its
  // answers then merge (turn.complete). A workflow's agents spawn no prompt Creole can rewrite.
  on('agent.spawn', async ($, e, next) => {
    const sid = s.cfg.wiki ? await $.session.id().catch(() => null) : null;
    const record = sid ? await sessionRecord($, sid).catch(() => null) : null;
    const share = subagentContext(s.skillText, checkGraph(record?.graph));
    if (!share) return next(e);
    const result = await next({ ...e, prompt: `${e.prompt}\n\n${share}` });
    if (result?.agentId) s.shared.add(result.agentId);
    return result;
  });

  // An unknown count (no response yet) is no measurement: it neither sets the base nor re-arms.
  on('session.measure', async ($, e, next) => {
    const { tokens } = e.context;
    const { floor, armed } = s;
    rebase(s, e.context.window, await $.session.model().catch(() => null));
    if (e.changed.includes('context')) s.sinceCompact++;
    if (tokens > 0 && tokens < s.floor) s.floor = tokens;
    if (tokens > 0 && tokens < limitOf(s)) s.armed = true;
    if (s.floor !== floor || s.armed !== armed) await retarget($, s);
    return next(e);
  });

  on('turn.complete', async ($, e, next) => {
    const result = await next(e);
    if (e.agentId) {
      if (e.reason === 'answer' && s.shared.has(e.agentId)) await merge($, s, e).catch(() => {});
      return result;
    }
    if (e.reason !== 'answer' || !s.autoCompact) return result;
    const { context, rateLimits } = await $.session.usage();
    rebase(s, context.window, null);
    const limit = limitOf(s);
    // Claude Code's debug log redacts numbers under keys that mention tokens, hence the short keys.
    $.ui.log(
      `creole-turn ${JSON.stringify({ ctx: context.tokens ?? null, limit: Math.round(limit), armed: s.armed, rateLimits })}`,
      { to: 'debug' },
    );
    if (!s.ownsEngine || !(context.tokens >= limit)) return result;
    // Compacting rejects while a turn runs, so start it once this one has ended.
    if (s.armed)
      $.clock.after(0, () => {
        if (s.armed && !s.busy)
          $.session
            .compact()
            .catch((err) =>
              $.ui.log(
                `creole-compact-refused ${JSON.stringify({ why: redactSecrets(String(err?.message ?? err)).slice(0, 200) })}`,
                { to: 'debug' },
              ),
            );
      });
    else if (!s.reported) {
      s.reported = true;
      $.ui.log(
        `Creole's last compaction left the conversation above its limit (${context.tokens} of ${Math.round(limit)} tokens), so it compacts again only once usage falls below that, or at Claude Code's own limit.`,
      );
    }
    return result;
  });

  on('session.compact', async ($, e, next) => {
    // A subagent's own transcript is short-lived: the engine compacts it.
    if (e.agentId) return next(e);
    // Compacting ahead of time would keep everything after that point verbatim.
    if (e.trigger === 'precompute') return { skip: 'Creole compacts when the conversation reaches its limit.' };
    // One at a time: a second would fork and replace the same conversation again.
    if (s.busy) return { skip: 'Creole is already compacting this conversation.' };
    s.busy = true;
    try {
      return await compact($, s, e, next);
    } finally {
      s.busy = false;
    }
  });

  // New input makes a compaction in flight stale. The engine keeping Creole's replacement is the
  // compaction's observed end: Claude Code 2.1.292 appends it as the engine's note (its boundary notice
  // comes by the compaction door), a row that carries the graph. One never seen kept stays issued,
  // unverified, and is not counted.
  on('session.append', async ($, e, next) => {
    if (!e.agentId && INPUT_DOORS.has(e.door)) s.rev++;
    const result = await next(e);
    // Claude Code 2.1.292 fires session.measure only after a turn, and a turn can read past the limit
    // after a compaction that left it below: disarmed, each main response reads the usage, which by
    // then counts the call before it (none yet at a turn's first response after a compaction).
    if (!s.armed && !e.agentId && e.door === 'response') {
      const tokens = (await $.session.usage().catch(() => null))?.context.tokens;
      if (tokens > 0 && tokens < limitOf(s)) {
        s.armed = true;
        await retarget($, s);
      }
    }
    if (e.agentId || e.door !== 'note' || e.origin?.kind !== 'engine' || !s.issued) return result;
    const text = (e.message?.content ?? [])
      .filter((b) => b?.type === 'text')
      .map((b) => b.text)
      .join('\n');
    if (text.includes(s.issued.rendered)) await committed($, s).catch(() => {});
    return result;
  });

  // The ended session, by the event's id: the process may already run under a new one (/clear).
  on('session.end', async ($, e, next) => {
    await changeRecord($, s, e.sessionId, (r) => (Object.keys(r).length ? { ended: true } : null));
    return next(e);
  });
};
