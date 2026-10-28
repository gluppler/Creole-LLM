// Creole for omp (Oh My Pi) and pi. Same skill and session graph as the Claude Code / Codex hooks,
// but omp lets an extension compact the session and supply the compaction summary, so here the
// graph replaces the transient history in place (the proposal's original design).
//
//   before_agent_start      keep the user's message; append the Creole language to the system prompt;
//                           at the threshold, ask for an update (once per crossing); re-inject the
//                           graph after a compaction that didn't use it as the summary
//   agent_end               apply the graph or delta from the reply, retry once on errors, then compact
//   session_before_compact  right after an update, the user's messages and the rendered graph are
//                           the compaction summary; past the budget, or with some of the user's messages
//                           unknown, omp's own summary runs, with a notice
//   session_compact         note whether the graph survived that compaction
//   session_start/switch/branch/tree  start over, with the user's messages from omp's record of the branch
//
// The first turn, and the first after each compaction, carry the project block (the codebase map, made then
// and never stored). omp has no subagent events, so no graph is shared or merged here; CREOLE_WIKI=off: no map.

import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent';
import {
  applyUpdate,
  config,
  degradedContext,
  emptyGraph,
  evaluateTrigger,
  extractUpdate,
  graphSkill,
  languageContext,
  projectBlock,
  projectRoot,
  readSkill,
  redactSecrets,
  reinjectContext,
  renderGraph,
  replayBudget,
  settingsNotice,
  skillNotice,
  triggerContext,
  triggerLimit,
} from '../lib/creole-core.mjs';

type Message = { role?: string; content?: unknown; stopReason?: string };

// A message's text: the string, or its text blocks joined; null when it has neither.
function textOf(m: Message): string | null {
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content))
    return m.content
      .filter((b) => b?.type === 'text')
      .map((b) => b.text)
      .join('\n');
  return null;
}

function lastAssistantText(messages: Message[] = []): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== 'assistant') continue;
    const text = textOf(m);
    if (text !== null) return text;
  }
  return null;
}

// The user's own messages on a branch of omp's session record, oldest first, redacted. Creole's
// messages are custom entries, not among them. Throws when there is no list to read.
function branchUsers(entries: unknown): string[] {
  if (!Array.isArray(entries)) throw new Error('no branch');
  return entries.flatMap((e) => {
    const text = e?.type === 'message' && e.message?.role === 'user' ? textOf(e.message) : null;
    return text?.trim() ? [redactSecrets(text)] : [];
  });
}

// Whether the context a branch gives still holds Creole's project block: its message at or after the
// last compaction's first kept entry (after the compaction itself when that entry is not found).
function holdsBlock(entries: unknown): boolean {
  if (!Array.isArray(entries)) return false;
  const last = entries.findLastIndex((e) => e?.type === 'compaction');
  const kept = last < 0 ? 0 : entries.findIndex((e) => e?.id === entries[last].firstKeptEntryId);
  return entries
    .slice(kept < 0 ? last + 1 : kept)
    .some((e) => e?.type === 'custom_message' && e.customType === 'creole' && textOf(e)?.includes('<creole-project>'));
}

export default function creole(pi: ExtensionAPI) {
  const cfg = config(process.env);
  // Read once at load: a running session keeps the language it started with.
  const text = readSkill();
  const language = cfg.language ? languageContext(text) : '';
  // The trigger's graph instructions, without the Language section; "" (no trigger) when unreadable.
  const skill = graphSkill(text);
  const notices = [skillNotice(text, cfg.language), settingsNotice(cfg)].filter(Boolean);
  const autoCompact = process.env.CREOLE_AUTO_COMPACT !== '0';
  // shortcut: the graph lives in memory, so a resumed omp session starts a new one; the last one still
  // survives inside the compaction summary. Persist via appendEntry if resume matters.
  // project: the next turn carries the project block.
  const fresh = () => ({
    armed: true,
    pending: false,
    retried: false,
    graph: emptyGraph(),
    summaryDue: false,
    reinject: false,
    floor: Infinity,
    window: 0,
    users: [] as string[],
    gap: false,
    project: true,
  });
  let state = fresh();
  // The user's messages and the graph, or null past the replay budget (replayBudget). With a gap, it
  // says some messages are missing.
  const restore = () =>
    reinjectContext(
      renderGraph(state.graph),
      state.users,
      replayBudget({ window: state.window || cfg.window, threshold: cfg.threshold, floor: state.floor, headroom: cfg.headroom }),
      state.gap,
    );

  // A new, resumed, forked or rewound session: its messages so far come from omp's record of the
  // branch. Where the host can't list them they are unknown, and no restore calls the rest complete.
  const reset = (
    _event: unknown,
    ctx: { sessionManager?: { getBranch(): unknown }; ui?: { notify?(m: string, t: string): void } },
  ) => {
    state = fresh();
    try {
      const branch = ctx.sessionManager?.getBranch();
      state.users = branchUsers(branch);
      state.project = !holdsBlock(branch);
    } catch {
      state.gap = true;
    }
    for (const n of notices) ctx.ui?.notify?.(n, 'warning');
  };
  pi.on('session_start', reset);
  pi.on('session_switch', reset);
  pi.on('session_branch', reset);
  pi.on('session_tree', reset);

  pi.on('before_agent_start', (event, ctx) => {
    // Once another turn starts, the graph cannot summarize all the history safely.
    state.summaryDue = false;
    // shortcut: assumes the fix message's turn (sendMessage) carries no prompt text; filter it if omp passes one.
    if (typeof event?.prompt === 'string' && event.prompt.trim()) state.users.push(redactSecrets(event.prompt));
    const parts: string[] = [];
    if (state.project) {
      state.project = false;
      try {
        parts.push(projectBlock(projectRoot(process.env, ctx.cwd)));
      } catch {}
    }
    if (state.reinject) {
      state.reinject = false;
      parts.push(restore() ?? degradedContext(renderGraph(state.graph)));
    }
    // Optional calls: omp has these; other pi-family hosts may not, and then Creole stays manual.
    const usage = ctx.getContextUsage?.();
    if (
      skill &&
      !state.pending &&
      usage &&
      Number.isFinite(usage.tokens) &&
      usage.tokens >= 0 &&
      usage.contextWindow > 0
    ) {
      // The smallest context seen is the session's base: system prompt, tools, restored state. Another
      // window (another model) has another base.
      // shortcut: a model switch that keeps the window keeps the old base; reset on omp's model event if that matters.
      if (usage.contextWindow !== state.window) Object.assign(state, { floor: Infinity, window: usage.contextWindow });
      if (usage.tokens > 0) state.floor = Math.min(state.floor, usage.tokens);
      const limit = triggerLimit({
        window: usage.contextWindow,
        threshold: cfg.threshold,
        floor: state.floor,
        headroom: cfg.headroom,
      });
      const r = evaluateTrigger({ tokens: usage.tokens, limit, armed: state.armed });
      state.armed = r.armed;
      if (r.fire) {
        state.pending = true;
        state.retried = false;
        parts.push(
          triggerContext({
            pct: (usage.tokens / usage.contextWindow) * 100,
            tokens: usage.tokens,
            window: usage.contextWindow,
            pass: state.graph.pass,
            maxWords: cfg.maxWords,
            skill,
          }),
        );
      }
    }
    // An older host without systemPrompt in the event gets no language rather than a lost prompt.
    const systemPrompt = language && Array.isArray(event?.systemPrompt) ? [...event.systemPrompt, language] : undefined;
    const content = parts.filter(Boolean).join('\n\n');
    if (!content && !systemPrompt) return;
    return {
      ...(content ? { message: { customType: 'creole', content, display: false } } : {}),
      ...(systemPrompt ? { systemPrompt } : {}),
    };
  });

  pi.on('agent_end', (event, ctx) => {
    if (event.willContinue) return;
    const messages = (event.messages ?? []) as Message[];
    // An interrupted or failed run's reply may be cut off: no graph is taken from it, and a request it
    // left pending is dropped, to be made again at the next turn, with no fix turn.
    const last = messages.findLast((m) => m?.role === 'assistant');
    if (last?.stopReason === 'aborted' || last?.stopReason === 'error') {
      if (state.pending) state = { ...state, pending: false, retried: false, armed: true };
      return;
    }
    const update = extractUpdate(lastAssistantText(messages));
    if (!update && !state.pending) return;

    const { graph, errors, tooLong } = applyUpdate(state.graph, update, cfg.maxWords);
    // Only enforce an update Creole asked for, and retry once, so a failing model never loops.
    // On the retry, an update whose only problem is length is kept anyway: long beats lost.
    const retryUsed = state.retried || !state.pending;
    if (errors.length && !(tooLong && retryUsed)) {
      if (retryUsed) {
        state.pending = false;
        return;
      }
      state.retried = true;
      pi.sendMessage(
        {
          customType: 'creole-fix',
          content: `Creole rejected your ${update?.kind ?? 'graph'}, so compaction would lose it. Fix only this, then reply with the corrected ${update?.kind ?? 'graph'}:\n- ${errors.join('\n- ')}`,
          display: false,
        },
        { triggerTurn: true },
      );
      return;
    }

    state = { ...state, pending: false, retried: false, graph, summaryDue: true };
    if (autoCompact && ctx.compact) {
      const scheduled = state;
      const compact = async () => {
        if (state !== scheduled || !state.summaryDue) return;
        try {
          await ctx.compact();
        } catch {
          ctx.ui?.notify?.('Creole compaction failed; graph retained.', 'warning');
        }
      };
      if (ctx.setTimeout) ctx.setTimeout(compact, 0);
      else setTimeout(compact, 0);
    }
  });

  pi.on('session_before_compact', (event, ctx) => {
    // The graph replaces the history only right after an update: later, it would drop whatever
    // happened since, so those compactions use omp's own summary and the graph is re-injected.
    if (!state.summaryDue) return;
    state.summaryDue = false;
    // Messages Creole never saw can't be called complete: omp summarizes then, as past the budget.
    const summary = state.gap ? null : restore();
    if (!summary) {
      ctx?.ui?.notify?.(
        state.gap
          ? "Creole could not keep all of the user's messages, so omp summarizes this compaction; the graph and the messages Creole kept come back after it."
          : "Creole could not restore the user's messages in full, so omp summarizes this compaction; the graph comes back after it.",
        'warning',
      );
      return;
    }
    const { firstKeptEntryId, tokensBefore } = event.preparation;
    return { compaction: { summary, firstKeptEntryId, tokensBefore } };
  });

  // The next turn carries the project block again unless an entry the compaction kept still holds it.
  pi.on('session_compact', (event, ctx) => {
    state.summaryDue = false;
    state.reinject = state.graph.pass > 0 && !event.compactionEntry?.summary?.includes(renderGraph(state.graph));
    try {
      state.project = !holdsBlock(ctx?.sessionManager?.getBranch());
    } catch {
      state.project = true;
    }
  });
}
