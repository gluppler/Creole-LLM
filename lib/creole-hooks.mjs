// Hook logic for every agent with command hooks. One handler serves them all: hosts differ only in
// event and field names (ROLES and the aliases below) and in the shape of injected context (inject).
// handle() takes the hook's stdin JSON and returns the JSON to print, plain text (PreCompact), or null.

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  addUser,
  applyUpdate,
  config,
  dataDir,
  degradedContext,
  emptyGraph,
  endSession,
  evaluateTrigger,
  extractUpdate,
  graphSkill,
  hasGap,
  languageContext,
  loadGraph,
  loadState,
  loadUsers,
  lastCompaction,
  lock,
  logEvent,
  mergeDelta,
  projectBlock,
  projectRoot,
  readContextUsage,
  readSkill,
  rebaseDelta,
  reinjectContext,
  renderGraph,
  resumeSession,
  saveGraph,
  saveState,
  sessionDir,
  settingsNotice,
  sharedGraph,
  skillNotice,
  subagentContext,
  triggerContext,
  triggerLimit,
  unlock,
} from './creole-core.mjs';

// Each host's event name and its role here. Claude Code, Codex, Qoder and CodeBuddy use Claude's names.
// Live-tested on Claude Code and Codex; the Cursor and Gemini CLI names follow their documented contracts.
const ROLES = {
  UserPromptSubmit: 'prompt',
  PostToolUse: 'prompt',
  Stop: 'stop',
  PreCompact: 'precompact',
  SessionStart: 'start',
  SessionEnd: 'end',
  SubagentStart: 'subagent',
  SubagentStop: 'subagentStop',
  beforeSubmitPrompt: 'prompt',
  postToolUse: 'prompt',
  afterAgentResponse: 'stop',
  sessionStart: 'start', // Cursor
  BeforeAgent: 'prompt',
  AfterTool: 'prompt',
  AfterAgent: 'stop', // Gemini CLI, Qwen Code (SessionStart as Claude's)
};

export function handle(input, env) {
  // SessionStart context and the module's system prompt section reach only the main thread (Claude Code
  // 2.1.292, probed), so each subagent gets the language section here, with the module or without.
  if (ROLES[input?.hook_event_name] === 'subagent') return onSubagentStart(input, env);
  // Claude Code's function-hook module (hooks/creole-module.mjs) compacts the session itself and
  // sets this for the processes it starts, so these hooks stand down where it runs.
  if (env.CREOLE_MODULE === '1') return null;
  const dir = sessionDir(dataDir(env), input?.session_id ?? input?.conversation_id); // Cursor: conversation_id
  if (!dir) return null;
  // A subagent's own prompts, tools and replies (Claude Code and Codex name it in agent_id) are not the main
  // session's: they count toward no trigger and keep no message. Its stop merges its delta.
  if (ROLES[input.hook_event_name] === 'subagentStop') return config(env).wiki ? onSubagentStop(input, dir) : null;
  if (input.agent_id) return null;
  // Codex also sets the CLAUDE_* compatibility aliases.
  const isCodex = Boolean(env.PLUGIN_DATA);

  switch (ROLES[input.hook_event_name]) {
    case 'prompt':
      return onPrompt(input, env, dir);
    case 'stop':
      return onStop(input, env, dir, isCodex);
    case 'precompact':
      return isCodex ? null : onPreCompact(dir, env);
    case 'start':
      return onSessionStart(input, env, dir, isCodex);
    case 'end':
      endSession(dir);
      return null; // the session can expire 30 days on
    default:
      return null;
  }
}

// Cursor reads additional_context, and its prompt hook also needs continue; the others take Claude's shape.
function inject(input, env, text) {
  const event = input.hook_event_name;
  if (!env.CURSOR_VERSION) return { hookSpecificOutput: { hookEventName: event, additionalContext: text } };
  return event === 'beforeSubmitPrompt' || event === 'UserPromptSubmit'
    ? { continue: true, additional_context: text }
    : { additional_context: text };
}

// Exact context size, from logs Creole can read (Claude Code transcripts, Codex rollouts).
function readUsage(input) {
  return input.transcript_path && existsSync(input.transcript_path) ? readContextUsage(input.transcript_path) : null;
}

// shortcut: where the host's log can't be read, the context's growth is estimated from what its hooks
// deliver, at 4 characters a token (the model's own tool calls and thinking go uncounted); add a reader for that log
// to make it exact.
const estimate = (input) => Math.ceil(JSON.stringify(input).length / 4);

// The project the codebase map is of: Cursor names its workspace roots instead of a cwd.
const rootOf = (input, env) => projectRoot(env, input.cwd ?? input.workspace_roots?.[0]);

// A subagent's start: the language section and, once the session has a graph, that graph with the skill's
// Subagents section (subagentContext). Under the module, whose agent.spawn shares the graph, and with
// CREOLE_WIKI=off, the language only. It only reads.
function onSubagentStart(input, env) {
  const cfg = config(env);
  const skill = readSkill();
  const dir = cfg.wiki && env.CREOLE_MODULE !== '1' && sessionDir(dataDir(env), input.session_id);
  const text = [cfg.language && languageContext(skill), dir && subagentContext(skill, loadGraph(dir))]
    .filter(Boolean)
    .join('\n\n');
  return text ? inject(input, env, text) : null;
}

// A subagent's stop: the delta its final reply ends with merges into the session graph (mergeDelta) under
// the session's lock. One with errors goes back once with the graph as it now stands; the retry's
// (stop_hook_active) is dropped and logged. Nothing else of the subagent is kept.
function onSubagentStop(input, dir) {
  const update = extractUpdate(input.last_assistant_message);
  if (!update || !existsSync(dir)) return null;
  const held = join(dir, 'users.lock');
  try {
    if (!lock(held, 5000)) return null;
  } catch {
    return null;
  }
  try {
    const stored = loadGraph(dir);
    const { graph, errors, ignored } = mergeDelta(stored, update);
    if (ignored) return null;
    if (!errors.length) {
      saveGraph(dir, graph, update);
      return null;
    }
    try {
      logEvent(dir, { event: 'merge', time: new Date().toISOString(), errors });
    } catch {}
    if (input.stop_hook_active) return null;
    return {
      decision: 'block',
      reason: `Creole rejected your delta, so the session graph would lose it. Fix only this, then end your reply with the corrected delta against the graph below:\n- ${errors.join('\n- ')}\n\n${sharedGraph(stored)}`,
    };
  } catch {
    return null;
  } finally {
    unlock(held);
  }
}

function onPrompt(input, env, dir) {
  // The prompt hooks (not PostToolUse) carry the user's message, which comes back whole after
  // compaction. One Creole could not keep is reported now, and the restore says it is missing.
  let lost = null;
  if (typeof input.prompt === 'string' && input.prompt.trim()) {
    try {
      addUser(dir, input.prompt);
    } catch (e) {
      lost = {
        systemMessage: `Creole could not keep this message (${e.message}), so the next compaction may lose it; restate it then if it still matters.`,
      };
    }
  }
  let reply = null;
  try {
    reply = checkTrigger(input, env, dir, typeof input.prompt === 'string');
  } catch {} // state refused at capacity: no request, but the notice above stands
  return lost || reply ? { ...lost, ...reply } : null;
}

// prompted: the user's prompt, not a tool's result, is what calls.
function checkTrigger(input, env, dir, prompted) {
  // Without its skill text Creole asks for no graph, and the host compacts on its own (skillNotice at start).
  const skill = graphSkill(readSkill());
  if (!skill || (!prompted && loadState(dir).pending)) return null;
  // The session's lock, as for a capture and a graph's save: one trigger, never during another's write.
  const held = join(dir, 'users.lock');
  try {
    mkdirSync(dir, { recursive: true });
    if (!lock(held)) return null;
  } catch {
    return null;
  }
  try {
    let state = loadState(dir); // another tool's hook may have fired before the lock was acquired
    if (state.pending) {
      if (!prompted) return null;
      // Still pending at the user's next prompt: that turn ended with no reply for Stop to check (it was
      // interrupted), so the request is dropped and may be made again.
      state = { ...state, pending: false, armed: true };
      saveState(dir, state);
    }
    const exact = readUsage(input);
    if (!exact && state.exact) return null; // compacted, and the host hasn't logged a fresh count yet
    const grown = exact ? undefined : (state.grown ?? 0) + estimate(input);
    const usage = exact ?? { tokens: grown, window: null };
    const cfg = config(env);
    const window = usage.window || cfg.window;
    // The smallest context seen is the session's base: system prompt, tools, restored state.
    // Estimates never set the base for exact counts, and another window (another model) has another base.
    // shortcut: a Claude Code log gives no window, so a model switch there keeps the old base, which only moves the
    // trigger earlier when the new base is larger; read message.model if that matters.
    const prior = (exact && !state.exact) || (state.window && state.window !== window) ? undefined : state.floor;
    const floor = usage.tokens > 0 ? Math.min(prior ?? Infinity, usage.tokens) : prior;
    const limit = triggerLimit({ window, threshold: cfg.threshold, floor, headroom: cfg.headroom });
    const r = evaluateTrigger({ tokens: usage.tokens, limit, armed: state.armed });
    saveState(dir, {
      ...state,
      exact: Boolean(exact) || state.exact,
      grown,
      floor,
      window,
      armed: r.armed,
      pending: r.fire,
    });
    if (!r.fire) return null;
    // What the trigger saw, for experiments: an estimate is labeled as one.
    try {
      logEvent(dir, {
        event: 'trigger',
        time: new Date().toISOString(),
        tokens: usage.tokens,
        limit: Math.round(limit),
        window,
        measured: Boolean(exact),
      });
    } catch {}
    const graph = loadGraph(dir);
    const text = [
      triggerContext({
        pct: (usage.tokens / window) * 100,
        tokens: usage.tokens,
        window,
        pass: graph?.pass ?? 0,
        maxWords: cfg.maxWords,
        skill,
      }),
      // A delta builds on the graph in the agent's context, and the stored one may be there only on
      // disk (saved, but no compaction since restored it), so it comes along.
      graph && `The session graph Creole stored, which the delta builds on:\n\n${renderGraph(graph)}`,
    ]
      .filter(Boolean)
      .join('\n\n');
    return inject(input, env, text);
  } finally {
    unlock(held);
  }
}

function onStop(input, env, dir, isCodex) {
  // The reply: Claude Code and Codex, Gemini CLI, Cursor.
  const update = extractUpdate(input.last_assistant_message ?? input.prompt_response ?? input.text);
  const prior = loadState(dir);
  const grows = !prior.exact && !readUsage(input); // no log to read: the reply's growth is estimated
  if (!update && !prior.pending && !grows) return null;
  // The graph and state change under the session's lock, read again under it, as a capture and a trigger do.
  const held = join(dir, 'users.lock');
  try {
    mkdirSync(dir, { recursive: true });
    if (!lock(held, 5000)) throw new Error('another hook kept the session busy');
  } catch (e) {
    // A request left pending is dropped at the user's next prompt.
    return update
      ? {
          systemMessage: `Creole could not save the session graph (${e.message}), so the next compaction restores an older graph or none; restate what it must keep.`,
        }
      : null;
  }
  try {
    return stop(input, env, dir, isCodex, update, grows);
  } finally {
    unlock(held);
  }
}

function stop(input, env, dir, isCodex, update, grows) {
  let state = loadState(dir);
  if (grows) {
    state = { ...state, grown: (state.grown ?? 0) + estimate(input) };
    try {
      saveState(dir, state);
    } catch {} // refused at capacity: this reply's growth goes uncounted
  }
  if (!update && !state.pending) return null;

  const base = loadGraph(dir) ?? emptyGraph();
  // A requested delta written against an older pass (a subagent's merged meanwhile) is carried onto the graph.
  const { graph, errors, tooLong } = applyUpdate(
    base,
    state.pending ? rebaseDelta(base, update) : update,
    config(env).maxWords,
  );
  // Only enforce an update Creole asked for, and only once, so a failing agent is never stuck in a loop.
  // On the retry, an update whose only problem is length is kept anyway: long beats lost.
  // The request ends here too, since hosts that ignore the block (Cursor) never send a retry.
  if (errors.length && state.pending && !input.stop_hook_active) {
    saveState(dir, { ...state, pending: false });
    return {
      decision: 'block',
      reason: `Creole rejected your ${update?.kind ?? 'graph'}, so compaction would lose it. Fix only this, then end your reply with the corrected ${update?.kind ?? 'graph'}:\n- ${errors.join('\n- ')}`,
    };
  }
  if (errors.length && !tooLong) {
    if (state.pending) saveState(dir, { ...state, pending: false });
    return null;
  }

  try {
    saveGraph(dir, graph, update);
  } catch (e) {
    try {
      saveState(dir, { ...state, pending: false });
    } catch {}
    return {
      systemMessage: `Creole could not save the session graph (${e.message}), so the next compaction restores an older graph or none; restate what it must keep.`,
    };
  }
  // A new graph restarts the estimate, so the next delta comes after another headroom of growth.
  saveState(dir, { ...state, pending: false, ...(!state.exact && { grown: 0 }) });
  // Codex shows systemMessage as a warning, so stay silent there.
  return isCodex
    ? null
    : {
        systemMessage: `Creole graph saved (pass ${graph.pass}). Compact the session to free context; the graph carries the work across.`,
      };
}

// Claude Code appends a PreCompact hook's stdout to the summarizer's instructions, for /compact and
// auto-compaction alike. The graph comes back afterwards, so the summary need not repeat it; the
// user's messages come back too, unless some were not kept or they don't fit, and then the summary must keep them.
function onPreCompact(dir, env) {
  const graph = loadGraph(dir);
  if (!graph?.nodes.T) return null;
  const rendered = renderGraph(graph);
  if (!restore(dir, env, rendered).lacking)
    return `Creole restores the user's messages and this session graph after compaction:\n\n${rendered}\n\nYour summary and the graph together must let the work continue. Cover only what the graph and the user's messages lack that the next step needs, as briefly as possible, and never repeat either.`;
  return `Creole restores this session graph after compaction, but not all of the user's messages:\n\n${rendered}\n\nYour summary and the graph together must let the work continue: keep every instruction of the user's that is still active, in their exact words where possible, and cover what else the next step needs that the graph lacks. Never repeat the graph.`;
}

// What comes back after compaction (text: null for the graph alone) and why the user's messages are
// not all in it: a record this version can't use, a budget of half the headroom (about 4 characters
// a token, so the work keeps the other half) they exceed, or messages that were never kept.
function restore(dir, env, rendered) {
  const users = loadUsers(dir);
  const gap = hasGap(dir);
  const text = users && reinjectContext(rendered, users, config(env).headroom * 2, gap);
  return { text, lacking: !users ? 'unavailable' : !text ? 'overflow' : gap ? 'incomplete' : null };
}

// Every session start (startup, resume, clear, compact) teaches the Creole language and adds the
// project block (the codebase map); after a compaction the user's messages and the graph come back too,
// saying which messages are missing, or past the budget the graph alone, saying so, with the gap on record
// in the session log. A skill Creole cannot read, or one without its Language section, is reported to the user.
// shortcut: under Claude Code's module this start runs before the module does, so its block is built and then dropped
// (prompt.attachment); a start that knew of the module would skip up to a second's scan.
// A resumed Codex thread replays its history, with the language this session's hook already added
// (Codex 0.162.1: two copies in the request after one resume), so Codex gets it once per session, and
// the project block likewise.
// But Codex 0.162.1 runs no SessionStart compact after a compaction that ends a turn: a thread resumed
// after one (its rollout's last compaction newer than Creole's last start text) is restored as one.
// A resumed thread that compacts before its turn runs SessionStart resume, then compact, after that one
// compaction, so Codex restores once per compaction (its window_id).
// shortcut: Claude Code's command-hook route still teaches it at every resume; whether that host replays it is
// unverified (06).
// shortcut: a compact hook that ran before its compaction reached the rollout would take an earlier one's id and skip;
// Codex 0.162.1 writes it first.
function onSessionStart(input, env, dir, isCodex) {
  // A resumed session is live again, and incomplete if its messages went unrecorded (resumeSession).
  if (input.source === 'resume')
    try {
      resumeSession(dir);
    } catch {}
  let source = input.source;
  let compaction = null; // Codex: the compaction this start follows
  if (
    isCodex &&
    (source === 'resume' || source === 'compact') &&
    input.transcript_path &&
    existsSync(input.transcript_path)
  )
    try {
      compaction = lastCompaction(input.transcript_path, source === 'resume');
      if (source === 'resume' && compaction !== null) source = 'compact';
      else if (compaction && compaction === loadState(dir).compaction) source = 'resume'; // restored at this resume
    } catch {}
  const graph = source === 'compact' ? loadGraph(dir) : null;
  const rendered = graph?.nodes.T && renderGraph(graph);
  let restored = null;
  if (rendered) {
    const { text, lacking } = restore(dir, env, rendered);
    restored = text ?? degradedContext(rendered);
    // The host's compaction, observed: a saved graph alone claims none.
    try {
      logEvent(dir, {
        event: lacking ? 'degraded' : 'restored',
        pass: graph.pass,
        ...(lacking && { reason: lacking }),
        time: new Date().toISOString(),
      });
    } catch {}
  }
  const skill = readSkill();
  const cfg = config(env);
  const replayed = isCodex && source === 'resume' ? loadState(dir) : {}; // what the replayed history holds
  const language = cfg.language && !replayed.language && languageContext(skill);
  let project = '';
  if (!replayed.project)
    try {
      project = projectBlock(rootOf(input, env));
    } catch {} // '' with CREOLE_WIKI=off: no scan
  const handled = source === 'compact' && compaction; // set on Codex only, '' without a window_id
  if (isCodex && (language || project || handled))
    remember(dir, {
      ...(language && { language: true }),
      ...(project && { project: true }),
      ...(handled && { compaction }),
    });
  const text = [language, project, restored].filter(Boolean).join('\n\n');
  const notice = [skillNotice(skill, cfg.language), settingsNotice(cfg)].filter(Boolean).join(' ');
  return text || notice ? { ...(text && inject(input, env, text)), ...(notice && { systemMessage: notice }) } : null;
}

// What the session's history now holds: the language, the compaction last restored after. Under the
// session's lock, as the trigger's state changes are; a state that cannot be written only means the next start repeats
// it.
function remember(dir, fields) {
  const held = join(dir, 'users.lock');
  try {
    mkdirSync(dir, { recursive: true });
    if (!lock(held)) return;
    try {
      const state = loadState(dir);
      if (Object.keys(fields).some((k) => state[k] !== fields[k])) saveState(dir, { ...state, ...fields });
    } finally {
      unlock(held);
    }
  } catch {}
}
