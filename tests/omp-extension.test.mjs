// Drives extensions/creole.ts through a mock of the omp ExtensionAPI.
// Node runs the .ts file directly (type stripping, Node >= 22.18).

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import creole from '../extensions/creole.ts';
import { degradedContext, languageContext, reinjectContext, renderGraph } from '../lib/creole-graph.mjs';
import { spyFs } from './spy-fs.mjs';

const GRAPH = `<!-- creole graph v2 · pass 1 · 2026-10-11T10:00:00Z · 130000 tokens -->
T: Port the CLI to Rust
C1: "no async runtime"
B1: \`src/args.rs\`: clap parser
S1: config loading | in progress | remaining: env overrides
L: Argument parser done`;

const DELTA = `<!-- creole delta v2 · pass 2 · 2026-10-11T12:00:00Z · 131000 tokens -->
- S1
+ B2: \`src/config.rs\`: config loading with env overrides
L: Config loading done`;

function setup(usage, plugin = creole) {
  const handlers = {};
  const sent = [];
  let compacts = 0;
  const pi = { on: (name, fn) => { handlers[name] = fn; }, sendMessage: (m, o) => sent.push([m, o]) };
  const ctx = {
    getContextUsage: () => usage.value,
    compact: async () => { compacts++; },
    setTimeout: (fn) => fn(),
  };
  plugin(pi);
  const reply = (text) => handlers.agent_end({ messages: [{ role: 'assistant', content: [{ type: 'text', text }] }] }, ctx);
  const compact = (id) => {
    const r = handlers.session_before_compact({ preparation: { firstKeptEntryId: id, tokensBefore: 130000 } }, ctx);
    handlers.session_compact({ compactionEntry: { summary: r?.compaction.summary ?? 'Native summary' } }, ctx);
    return r;
  };
  return { handlers, sent, ctx, reply, compact, compacts: () => compacts };
}

test('omp: appends the Creole language to the system prompt on every turn, alongside a trigger', () => {
  const usage = { value: { tokens: 100000, contextWindow: 200000, percent: 50 } };
  const { handlers, ctx } = setup(usage);
  const r = handlers.before_agent_start({ systemPrompt: ['You are omp.'] }, ctx);
  assert.equal(r.message, undefined);
  assert.equal(r.systemPrompt.length, 2);
  assert.equal(r.systemPrompt[0], 'You are omp.');
  assert.equal(r.systemPrompt[1], languageContext(readFileSync(new URL('../skills/creole/SKILL.md', import.meta.url), 'utf8')), 'the whole section: language, work and replies');
  usage.value = { tokens: 130000, contextWindow: 200000, percent: 65 };
  const both = handlers.before_agent_start({ systemPrompt: ['You are omp.'] }, ctx);
  assert.match(both.message.content, /the full creole graph/);
  assert.equal(both.systemPrompt.length, 2);
  // The trigger carries the graph instructions only: the language is in the system prompt once.
  assert.match(both.message.content, /<creole-skill>\n# Creole\n[\s\S]*## Classification[\s\S]*## Summary generation/);
  assert.doesNotMatch(both.message.content, /## Language|working language|# Creole language/);
});

// Runs fn with CREOLE_LANGUAGE set as given, since the extension reads process.env when it loads.
function withLanguage(value, fn) {
  const before = process.env.CREOLE_LANGUAGE;
  process.env.CREOLE_LANGUAGE = value;
  try { return fn(); } finally { if (before === undefined) delete process.env.CREOLE_LANGUAGE; else process.env.CREOLE_LANGUAGE = before; }
}

test('omp: with the language off, the system prompt is untouched, and the trigger and the correction carry no language rules', () => {
  const usage = { value: { tokens: 130000, contextWindow: 200000, percent: 65 } };
  const { handlers, sent, ctx, reply } = withLanguage('off', () => setup(usage));
  const r = handlers.before_agent_start({ systemPrompt: ['You are omp.'] }, ctx);
  assert.equal(r.systemPrompt, undefined);
  assert.match(r.message.content, /the full creole graph[\s\S]*<creole-skill>\n# Creole\n[\s\S]*## Classification/);
  assert.doesNotMatch(r.message.content, /## Language|working language|# Creole language/);
  reply('Done.\n\n<!-- creole graph v2 · pass 1 · broken');
  assert.equal(sent.length, 1);
  assert.doesNotMatch(sent[0][0].content, /working language|# Creole language|## Language/);
});

// A copy of the extension with no skill, or the given SKILL.md.
async function pluginCopy(skill) {
  const root = mkdtempSync(join(tmpdir(), 'creole-omp-'));
  for (const d of ['lib', 'extensions']) cpSync(new URL(`../${d}`, import.meta.url), join(root, d), { recursive: true });
  if (skill !== undefined) {
    mkdirSync(join(root, 'skills', 'creole'), { recursive: true });
    writeFileSync(join(root, 'skills', 'creole', 'SKILL.md'), skill);
  }
  return (await import(pathToFileURL(join(root, 'extensions', 'creole.ts')).href)).default;
}

test('omp: a skill it cannot read means no language, no trigger and a notice; one without its Language section keeps the graph', async () => {
  const usage = { value: { tokens: 130000, contextWindow: 200000, percent: 65 } };
  for (const [skill, notice, trigger] of [
    [undefined, 'Creole could not read its skill, so the Creole language and session graph are off this session; the host compacts on its own.', false],
    [readFileSync(new URL('../skills/creole/SKILL.md', import.meta.url), 'utf8').replace(/\n## Language\n[\s\S]*?(?=\n## )/, ''), 'Creole\'s skill has no Language section, so the Creole language is off this session.', true],
  ]) {
    const { handlers, ctx } = setup(usage, await pluginCopy(skill));
    const notes = [];
    ctx.ui = { notify: (text, level) => notes.push([text, level]) };
    handlers.session_start({}, ctx);
    assert.deepEqual(notes, [[notice, 'warning']]);
    const r = handlers.before_agent_start({ systemPrompt: ['You are omp.'] }, ctx);
    if (trigger) assert.match(r.message.content, /<creole-skill>\n# Creole\n/);
    else assert.equal(r, undefined, 'no language and no graph request; the host prompt stays');
    if (trigger) assert.equal(r.systemPrompt, undefined);
  }
});

test('omp: full graph, then compaction with the graph as the summary, then a delta on the next pass', () => {
  const usage = { value: { tokens: 100000, contextWindow: 200000, percent: 50 } };
  const { handlers, sent, ctx, reply, compact, compacts } = setup(usage);

  assert.equal(handlers.before_agent_start({}, ctx), undefined);
  usage.value = { tokens: 130000, contextWindow: 200000, percent: 65 };
  assert.match(handlers.before_agent_start({}, ctx).message.content, /65%.*the full creole graph.*pass 1/s);
  assert.equal(handlers.before_agent_start({}, ctx), undefined, 'fires once per crossing');

  reply('Done.\n\n<!-- creole graph v2 · pass 1 · broken');
  assert.equal(sent.length, 1);
  assert.equal(sent[0][1].triggerTurn, true);
  assert.equal(compacts(), 0);

  reply(`Fixed.\n\n${GRAPH}`);
  assert.equal(compacts(), 1);
  const first = compact('e42');
  assert.equal(first.compaction.firstKeptEntryId, 'e42');
  assert.ok(first.compaction.summary.endsWith(GRAPH));

  usage.value = { tokens: 30000, contextWindow: 200000, percent: 15 };
  assert.equal(handlers.before_agent_start({}, ctx), undefined, 'no re-injection: the graph was the summary');
  usage.value = { tokens: 131000, contextWindow: 200000, percent: 66 };
  assert.match(handlers.before_agent_start({}, ctx).message.content, /a creole delta against the restored graph.*pass 2/s);
  reply(DELTA);
  assert.equal(compacts(), 2);
  const second = compact('e90').compaction.summary;
  assert.match(second, /pass 2/);
  assert.match(second, /B2: `src\/config.rs`/);
  assert.doesNotMatch(second, /S1:/);
});

test('omp: the user\'s prompts and the graph form the summary; a rejected graph teaches the next request nothing', (t) => {
  const usage = { value: { tokens: 100000, contextWindow: 200000, percent: 50 } };
  const { handlers, sent, ctx, reply, compact } = setup(usage);
  ctx.cwd = mkdtempSync(join(tmpdir(), 'creole-omp-cli-')); // an empty project: no map to scan
  t.after(() => rmSync(ctx.cwd, { recursive: true, force: true }));
  handlers.before_agent_start({ prompt: 'Port the CLI to Rust, no async runtime' }, ctx);
  usage.value = { tokens: 130000, contextWindow: 200000, percent: 65 };
  assert.match(handlers.before_agent_start({ prompt: 'Then add config loading' }, ctx).message.content, /the full creole graph/);
  reply(GRAPH.replace('C1: "', 'C1: '));
  assert.match(sent.at(-1)[0].content, /C1: a constraint/);
  reply(GRAPH);
  assert.equal(compact('e1').compaction.summary, reinjectContext(GRAPH, ['Port the CLI to Rust, no async runtime', 'Then add config loading']));

  usage.value = { tokens: 40000, contextWindow: 200000, percent: 20 };
  handlers.before_agent_start({ prompt: '' }, ctx);
  usage.value = { tokens: 131000, contextWindow: 200000, percent: 66 };
  const next = handlers.before_agent_start({}, ctx).message.content;
  assert.match(next, /a creole delta against the restored graph \(pass 2,/);
  assert.doesNotMatch(next, /Rules earlier graphs/);
});

test('omp: past the budget omp summarizes, with a notice, and the graph comes back saying the messages could not', () => {
  process.env.CREOLE_HEADROOM_TOKENS = '1000'; // a 2,000-character budget
  try {
    const usage = { value: { tokens: 130000, contextWindow: 200000 } };
    const { handlers, ctx, reply, compact } = setup(usage);
    const notes = [];
    ctx.ui = { notify: (text, level) => notes.push([text, level]) };
    handlers.before_agent_start({ prompt: `Keep "at most 2 retries". ${'details '.repeat(400)}` }, ctx);
    reply(GRAPH);
    assert.equal(compact('e1'), undefined, 'omp\'s own summary runs');
    assert.deepEqual(notes.map(([, level]) => level), ['warning']);
    assert.match(notes[0][0], /could not restore the user's messages in full/);
    usage.value = { tokens: 1000, contextWindow: 200000 };
    assert.equal(handlers.before_agent_start({}, ctx).message.content, degradedContext(GRAPH));
  } finally {
    delete process.env.CREOLE_HEADROOM_TOKENS;
  }
});

test('omp: after a resume or rewind, the summary takes the user\'s messages from omp\'s record of the branch', () => {
  const { handlers, ctx, reply, compact } = setup({ value: { tokens: 130000, contextWindow: 200000 } });
  const branch = [
    { type: 'session_init' },
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'Port the CLI to Rust, no async runtime' }] } },
    { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'Started.' }] } },
    { type: 'custom_message', customType: 'creole', content: 'CREOLE: this session is at 65%' },
    { type: 'message', message: { role: 'user', content: 'Use sk-FAKEsecret0123456789abcdef in CI' } },
  ];
  ctx.sessionManager = { getBranch: () => branch };
  for (const event of ['session_start', 'session_switch', 'session_branch', 'session_tree']) {
    handlers[event]({}, ctx);
    handlers.before_agent_start({ prompt: 'Then add config loading' }, ctx);
    reply(GRAPH);
    assert.equal(compact('e1').compaction.summary, reinjectContext(GRAPH, ['Port the CLI to Rust, no async runtime', 'Use [credential removed] in CI', 'Then add config loading']), event);
  }
});

test('omp: where the host cannot list the branch, omp summarizes, and the restore says which messages are missing', () => {
  const usage = { value: { tokens: 130000, contextWindow: 200000 } };
  const { handlers, ctx, reply, compact } = setup(usage);
  const notes = [];
  ctx.ui = { notify: (text, level) => notes.push([text, level]) };
  handlers.session_start({}, ctx); // a resumed session's earlier messages are unknown
  handlers.before_agent_start({ prompt: 'Then add config loading' }, ctx);
  reply(GRAPH);
  assert.equal(compact('e1'), undefined, 'omp\'s own summary runs');
  assert.deepEqual(notes.map(([, level]) => level), ['warning']);
  assert.match(notes[0][0], /could not keep all of the user's messages/);
  usage.value = { tokens: 1000, contextWindow: 200000 };
  assert.equal(handlers.before_agent_start({}, ctx).message.content, reinjectContext(GRAPH, ['Then add config loading'], Infinity, true));
});

test('omp: a later native compaction keeps omp\'s summary and re-injects the graph on the next turn', () => {
  const usage = { value: { tokens: 130000, contextWindow: 200000, percent: 65 } };
  const { handlers, ctx, reply, compact } = setup(usage);
  handlers.before_agent_start({}, ctx);
  reply(GRAPH);
  compact('e1');
  assert.equal(compact('e2'), undefined, 'the graph is used as the summary only right after an update');
  usage.value = { tokens: 20000, contextWindow: 200000, percent: 10 };
  const msg = handlers.before_agent_start({}, ctx).message.content;
  assert.match(msg, /this graph restores its task/);
  assert.ok(msg.endsWith(GRAPH));
});

test('omp: gives up after one failed retry and ignores ordinary replies', () => {
  const usage = { value: { tokens: 190000, contextWindow: 200000, percent: 95 } };
  const { handlers, sent, ctx, reply, compacts } = setup(usage);
  reply('ordinary reply');
  assert.equal(sent.length, 0);

  handlers.before_agent_start({}, ctx);
  reply('forgot');
  reply('forgot again');
  reply('and again');
  assert.equal(sent.length, 1);
  assert.equal(compacts(), 0);
  assert.equal(handlers.session_before_compact({ preparation: { firstKeptEntryId: 'x', tokensBefore: 1 } }, ctx), undefined);
});

test('omp: asks once to shorten an over-limit graph, then keeps it', () => {
  process.env.CREOLE_MAX_WORDS = '20';
  try {
    const { handlers, sent, ctx, reply, compacts } = setup({ value: { tokens: 190000, contextWindow: 200000, percent: 95 } });
    handlers.before_agent_start({}, ctx);
    reply(GRAPH);
    assert.match(sent[0][0].content, /limit is 20/);
    assert.equal(compacts(), 0);
    reply(GRAPH);
    assert.equal(compacts(), 1);
  } finally {
    delete process.env.CREOLE_MAX_WORDS;
  }
});

test('omp: no usage yet means no trigger', () => {
  const { handlers, ctx } = setup({ value: undefined });
  assert.equal(handlers.before_agent_start({}, ctx), undefined);
});

test('omp: a later turn invalidates a graph as a complete compaction summary', () => {
  const { handlers, ctx, reply, compact } = setup({ value: { tokens: 130000, contextWindow: 200000 } });
  handlers.before_agent_start({}, ctx);
  reply(GRAPH);
  handlers.before_agent_start({}, ctx);
  reply('The user changed the requirement; newer work must survive.');
  assert.equal(compact('later'), undefined);
  assert.match(handlers.before_agent_start({}, ctx).message.content, /this graph restores its task/);
});

test('omp: pending requests do not retrigger or reset their one retry', () => {
  const usage = { value: { tokens: 130000, contextWindow: 200000 } };
  const { handlers, ctx, reply, sent } = setup(usage);
  handlers.before_agent_start({}, ctx);
  reply('forgot');
  usage.value.tokens = 1000;
  assert.equal(handlers.before_agent_start({}, ctx), undefined);
  usage.value.tokens = 130000;
  assert.equal(handlers.before_agent_start({}, ctx), undefined);
  reply('forgot again');
  assert.equal(sent.length, 1);
});

test('omp: an interrupted or failed run drops its pending request with no fix turn and takes no graph from its reply; the next turn asks again', () => {
  for (const stopReason of ['aborted', 'error']) {
    const { handlers, sent, ctx, compacts } = setup({ value: { tokens: 130000, contextWindow: 200000 } });
    assert.match(handlers.before_agent_start({}, ctx).message.content, /the full creole graph/);
    handlers.agent_end({ messages: [{ role: 'assistant', content: [{ type: 'text', text: GRAPH }], stopReason }] }, ctx);
    assert.equal(sent.length, 0, stopReason);
    assert.equal(compacts(), 0, stopReason);
    assert.match(handlers.before_agent_start({}, ctx).message.content, /the full creole graph.*pass 1/s, stopReason);
  }
});

test('omp: another window (another model) resets the base; invalid settings are named at session start', () => {
  const usage = { value: { tokens: 30000, contextWindow: 200000 } };
  process.env.CREOLE_HEADROOM_TOKENS = '40000'; // the base-plus-headroom mechanism (the default is larger)
  const { handlers, ctx } = setup(usage);
  delete process.env.CREOLE_HEADROOM_TOKENS;
  assert.equal(handlers.before_agent_start({}, ctx), undefined);
  usage.value = { tokens: 90000, contextWindow: 1000000 };
  assert.equal(handlers.before_agent_start({}, ctx), undefined, 'the old base would put the limit at 70k');
  usage.value.tokens = 131000;
  assert.match(handlers.before_agent_start({}, ctx).message.content, /13%.*the full creole graph/s);

  process.env.CREOLE_THRESHOLD_PERCENT = '0';
  try {
    const bad = setup({ value: undefined });
    const notes = [];
    bad.ctx.ui = { notify: (text, level) => notes.push([text, level]) };
    bad.handlers.session_start({}, bad.ctx);
    assert.equal(notes.length, 1);
    assert.match(notes[0][0], /^Creole ignored invalid settings \(CREOLE_THRESHOLD_PERCENT\): /);
    assert.equal(notes[0][1], 'warning');
  } finally {
    delete process.env.CREOLE_THRESHOLD_PERCENT;
  }
});

test('omp: zero context tokens rearm the trigger after a completed request', () => {
  const usage = { value: { tokens: 130000, contextWindow: 200000 } };
  const { handlers, ctx, reply, compact } = setup(usage);
  handlers.before_agent_start({}, ctx);
  reply(GRAPH);
  compact('first');
  usage.value.tokens = 0;
  assert.equal(handlers.before_agent_start({}, ctx), undefined);
  usage.value.tokens = 130000;
  assert.match(handlers.before_agent_start({}, ctx).message.content, /pass 2/);
});

test('omp: session changes discard the old graph and queued compaction', async () => {
  for (const event of ['session_start', 'session_switch', 'session_branch', 'session_tree']) {
    const { handlers, ctx, reply, compacts } = setup({ value: { tokens: 130000, contextWindow: 200000 } });
    let queued;
    ctx.setTimeout = (fn) => { queued = fn; };
    handlers.before_agent_start({}, ctx);
    reply(GRAPH);
    assert.equal(typeof handlers[event], 'function', event);
    handlers[event]({}, ctx);
    await queued();
    assert.equal(compacts(), 0, event);
    assert.match(handlers.before_agent_start({}, ctx).message.content, /the full creole graph.*pass 1/s, event);
  }
});

test('omp: queued compaction does not interrupt newer work and failures are handled', async () => {
  const { handlers, ctx, reply, compacts } = setup({ value: { tokens: 130000, contextWindow: 200000 } });
  let queued;
  ctx.setTimeout = (fn) => { queued = fn; };
  handlers.before_agent_start({}, ctx);
  reply(GRAPH);
  handlers.before_agent_start({}, ctx);
  await queued();
  assert.equal(compacts(), 0);

  reply(DELTA);
  ctx.compact = async () => { throw new Error('compaction cancelled'); };
  await assert.doesNotReject(queued);
});

test('omp: actual compaction output controls reinjection, including native preservation and cancellation', () => {
  const usage = { value: { tokens: 130000, contextWindow: 200000 } };
  const { handlers, ctx, reply } = setup(usage);
  handlers.before_agent_start({}, ctx);
  reply(GRAPH);
  handlers.session_before_compact({ preparation: { firstKeptEntryId: 'cancelled', tokensBefore: 130000 } }, ctx);
  // Another extension can cancel or replace the proposed graph summary.
  handlers.session_compact({ compactionEntry: { summary: 'Newer native summary' } }, ctx);
  usage.value.tokens = 1000;
  assert.match(handlers.before_agent_start({}, ctx).message.content, /this graph restores its task/);
  handlers.session_compact({ compactionEntry: { summary: `Native summary preserving anchors:\n${GRAPH}` } }, ctx);
  assert.equal(handlers.before_agent_start({}, ctx), undefined, 'do not inject a graph already in the summary');
});

test('omp: the project wikis and profile earlier versions kept stay byte for byte and unread through whole sessions, with CREOLE_WIKI unset, show, reset, forget or off', (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'creole-omp-old-')));
  const cwd = join(base, 'app');
  mkdirSync(cwd);
  const data = join(base, 'data');
  const saved = { data: process.env.CLAUDE_PLUGIN_DATA, wiki: process.env.CREOLE_WIKI };
  t.after(() => {
    for (const [k, v] of [['CLAUDE_PLUGIN_DATA', saved.data], ['CREOLE_WIKI', saved.wiki]]) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    rmSync(base, { recursive: true, force: true });
  });
  process.env.CLAUDE_PLUGIN_DATA = data;
  const dir = join(data, 'projects', createHash('sha256').update(cwd).digest('hex').slice(0, 16));
  mkdirSync(dir, { recursive: true });
  const old = {
    [join(dir, 'wiki-v3.json')]: JSON.stringify({ v: 3, root: cwd, lessons: { quote: { seen: 1, time: '2026-10-19T12:00:00Z' } }, headroom: [], log: [], facts: [] }),
    [join(dir, 'wiki-v4.json')]: JSON.stringify({ v: 4, root: cwd, lessons: {}, headroom: [], log: [], graph: null, filed: null }),
    [join(data, 'profile-v1.json')]: JSON.stringify({ v: 1, prefs: [{ text: '"keep replies under five lines"', subject: 'replies', seen: 1, time: '2026-10-19T12:00:00Z' }] }),
  };
  for (const [path, text] of Object.entries(old)) writeFileSync(path, text);
  const touched = spyFs(t, (p) => p.startsWith(data));
  for (const action of [undefined, 'show', 'reset', 'forget', 'off']) {
    if (action) process.env.CREOLE_WIKI = action; else delete process.env.CREOLE_WIKI;
    const usage = { value: { tokens: 1000, contextWindow: 200000 } };
    const { handlers, ctx, reply, compact } = setup(usage);
    const notes = [];
    Object.assign(ctx, { cwd, ui: { notify: (text) => notes.push(text) } });
    handlers.session_start({}, ctx);
    const first = handlers.before_agent_start({ prompt: 'From now on, keep replies under five lines. Port the CLI to Rust.' }, ctx);
    assert.doesNotMatch(first?.message?.content ?? '', /five lines|Rules earlier graphs/, action);
    usage.value = { tokens: 130000, contextWindow: 200000 };
    handlers.before_agent_start({ prompt: 'go' }, ctx);
    reply('no graph');
    reply(GRAPH);
    compact('kept');
    assert.deepEqual(notes.filter((n) => /wiki|profile|preference/i.test(n)), [], `${action}: no wiki or profile notice`);
  }
  assert.deepEqual(touched, []);
  for (const [path, text] of Object.entries(old)) assert.equal(readFileSync(path, 'utf8'), text, path);
});

test('omp: the first turn, and the first after each compaction that kept no copy, carry the project block once, made then and never stored; a new session starts with no graph; off scans nothing', (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'creole-omp-project-')));
  const cwd = join(base, 'app');
  mkdirSync(join(cwd, 'src'), { recursive: true });
  writeFileSync(join(cwd, 'src', 'args.rs'), 'pub fn parse() {}\n');
  const saved = { data: process.env.CLAUDE_PLUGIN_DATA, wiki: process.env.CREOLE_WIKI };
  t.after(() => {
    for (const [k, v] of [['CLAUDE_PLUGIN_DATA', saved.data], ['CREOLE_WIKI', saved.wiki]]) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    rmSync(base, { recursive: true, force: true });
  });
  process.env.CLAUDE_PLUGIN_DATA = join(base, 'data');
  delete process.env.CREOLE_WIKI;
  const blocks = (r) => (r?.message?.content ?? '').split('<creole-project>').length - 1;
  const usage = { value: { tokens: 1000, contextWindow: 200000 } };
  const { handlers, ctx, reply, compact } = setup(usage);
  ctx.cwd = cwd;
  const first = handlers.before_agent_start({ prompt: 'Port the CLI to Rust, "no async runtime".' }, ctx);
  assert.equal(blocks(first), 1);
  assert.match(first.message.content, /\nsrc\/: parse\n<\/creole-project>$/);
  assert.equal(blocks(handlers.before_agent_start({ prompt: 'next' }, ctx)), 0, 'once');
  usage.value = { tokens: 130000, contextWindow: 200000 };
  handlers.before_agent_start({ prompt: 'go' }, ctx);
  reply(GRAPH);
  compact('kept-1');
  writeFileSync(join(cwd, 'src', 'log.rs'), 'pub fn init() {}\n');
  usage.value = { tokens: 1000, contextWindow: 200000 };
  const after = handlers.before_agent_start({ prompt: 'continue' }, ctx);
  assert.equal(blocks(after), 1, 'after the compaction');
  assert.match(after.message.content, /\nsrc\/: [^\n]*\binit\b/, 'the project as it now is');
  assert.equal(existsSync(join(base, 'data')), false, 'nothing of the project is stored');
  // An entry the compaction kept holds the block: no second copy, though the graph comes back.
  ctx.sessionManager = { getBranch: () => [{ type: 'custom_message', id: 'k1', customType: 'creole', content: after.message.content }, { type: 'compaction', firstKeptEntryId: 'k1' }] };
  handlers.session_compact({ compactionEntry: { summary: 'Native summary' } }, ctx);
  const kept = handlers.before_agent_start({ prompt: 'more' }, ctx);
  assert.equal(blocks(kept), 0);
  assert.match(kept.message.content, /this record restores its task[^]*\nC1: "no async runtime"/);
  // A resumed branch: the block comes again only when its context lacks one.
  handlers.session_start({}, ctx);
  assert.equal(blocks(handlers.before_agent_start({ prompt: 'resumed' }, ctx)), 0);
  ctx.sessionManager = { getBranch: () => [{ type: 'message', message: { role: 'user', content: 'hi' } }] };
  handlers.session_start({}, ctx);
  const resumed = handlers.before_agent_start({ prompt: 'resumed' }, ctx);
  assert.equal(blocks(resumed), 1);
  assert.doesNotMatch(resumed.message.content, /Port the CLI|no async runtime/, 'no graph crosses into the new session');
  usage.value = { tokens: 130000, contextWindow: 200000 };
  assert.match(handlers.before_agent_start({ prompt: 'go' }, ctx).message.content, /the full creole graph \(pass 1, /);
  reply(GRAPH);
  compact('kept-3');
  usage.value = { tokens: 1000, contextWindow: 200000 };
  // A copy before what a compaction kept left the context with the rest: the block comes again.
  ctx.sessionManager = { getBranch: () => [{ type: 'custom_message', id: 'k1', customType: 'creole', content: after.message.content }, { type: 'message', id: 'k2', message: { role: 'user', content: 'hi' } }, { type: 'compaction', firstKeptEntryId: 'k2' }] };
  handlers.session_compact({ compactionEntry: { summary: 'Native summary' } }, ctx);
  assert.equal(blocks(handlers.before_agent_start({ prompt: 'again' }, ctx)), 1);

  process.env.CREOLE_WIKI = 'off';
  const touched = spyFs(t, (p) => p.startsWith(base));
  const off = setup(usage);
  off.ctx.cwd = cwd;
  assert.equal(blocks(off.handlers.before_agent_start({ prompt: 'go' }, off.ctx)), 0);
  usage.value = { tokens: 130000, contextWindow: 200000 };
  off.handlers.before_agent_start({ prompt: 'go' }, off.ctx);
  off.reply(GRAPH);
  off.compact('kept-2');
  usage.value = { tokens: 1000, contextWindow: 200000 };
  assert.equal(blocks(off.handlers.before_agent_start({ prompt: 'go' }, off.ctx)), 0);
  assert.deepEqual([...touched], []);
});
