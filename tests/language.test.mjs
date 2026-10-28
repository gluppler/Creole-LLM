import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { FACTS, grade, HUMAN, MEANING, meaningLost, PAYLOADS, payloadKept, readable, score, STATE } from '../experiments/language/meaning.mjs';
import { graphSkill, languageContext, wordCount } from '../lib/creole-graph.mjs';

const lost = (text) => Object.entries(grade(text)).filter(([, ok]) => !ok).map(([k]) => k);
const SKILL = readFileSync(new URL('../skills/creole/SKILL.md', import.meta.url), 'utf8');
const labels = (text) => text.match(/^[a-z]+:|; [a-z]+:/gm) ?? [];

test('language decode grader: the plain-English state holds all 14 facts; a dropped hedge or an abbreviation loses exactly one', () => {
  assert.equal(score(grade(STATE)), Object.keys(FACTS).length);
  assert.deepEqual(lost(STATE.replace('Likely cause, not yet confirmed:', 'Cause:')), ['causeUnconfirmed']);
  assert.deepEqual(lost(STATE.replace('TypeScript', 'TS')), ['stack']);
  assert.deepEqual(lost(`${STATE}\ncause: catch block in withRetry rethrows error instead of retrying, unconfirmed`.replace('Likely cause, not yet confirmed:', 'Cause:')), []);
});

test('meaning fixtures: source and Creole keep every element; each negative loses the one it changes, though a word count or label check cannot tell', () => {
  for (const f of MEANING) {
    assert.deepEqual(meaningLost(f, f.source), [], `${f.id} source`);
    assert.deepEqual(meaningLost(f, f.creole), [], `${f.id} creole`);
    assert.ok(wordCount(f.creole) < wordCount(f.source), `${f.id}: the Creole is shorter`);
    for (const n of f.negatives) {
      assert.deepEqual(meaningLost(f, n.text), [n.breaks], `${f.id} negative ${n.breaks}`);
      assert.ok(Math.abs(wordCount(n.text) - wordCount(f.creole)) <= 1, `${f.id} ${n.breaks}: same length`);
      assert.deepEqual(labels(n.text), labels(f.creole), `${f.id} ${n.breaks}: same labels`);
    }
  }
  // Four edits of the example, each rejected on its own.
  const retry = MEANING.find((f) => f.id === 'retry-policy');
  assert.deepEqual(retry.negatives.map((n) => n.breaks), ['uncertainty', 'condition', 'count', 'unit', 'order']);
  assert.deepEqual(meaningLost(retry, retry.creole.replace('unconfirmed', '')), ['uncertainty']);
  assert.deepEqual(meaningLost(retry, retry.creole.replace('only', 'also')), ['condition']);
});

test('payload fixtures: code, commands, identifiers, quoted errors, files, commit text and literal replies pass only byte for byte', () => {
  assert.deepEqual(PAYLOADS.map((p) => p.id), ['code', 'command', 'identifier', 'quoted-error', 'file', 'commit', 'literal']);
  for (const p of PAYLOADS) {
    assert.equal(payloadKept(p, p.whole ? p.exact : `done:\n\n${p.exact}\n\nnext: run tests`), true, p.id);
    for (const n of p.negatives) assert.equal(payloadKept(p, p.whole ? n : `done:\n\n${n}\n\nnext: run tests`), false, `${p.id}: ${n}`);
  }
});

test('human fixtures: warnings, questions and requested prose stay full sentences; the terse form fails', () => {
  for (const h of HUMAN) {
    assert.equal(readable(h.readable), true, h.id);
    assert.equal(readable(h.terse), false, h.id);
  }
  for (const f of MEANING) assert.equal(readable(f.creole), false, `${f.id}: Creole notes are not for a person`);
});

test('SKILL.md Language: keeps meaning-bearing words, drops only filler, and its own example passes the meaning fixture', () => {
  const rules = languageContext(SKILL);
  assert.doesNotMatch(rules, /hedges/, 'no blanket rule to drop hedges');
  for (const kept of ['uncertainty', 'conditions', 'negation', 'numbers with their units', 'sources', 'the order of steps']) assert.ok(rules.includes(kept), kept);
  assert.match(rules, /filler that carries no meaning/);
  const example = /`(cause: unconfirmed;[^`]+)`/.exec(rules)[1];
  assert.deepEqual(meaningLost(MEANING.find((f) => f.id === 'retry-policy'), example), []);
  for (const exact of ['Code, commands, paths, identifiers', 'errors, quotes, file contents, commit and pull request text', 'output the user asks for word for word stay exact']) assert.ok(rules.includes(exact), exact);
  assert.match(rules, /Plain English in full sentences to ask the user something, to warn of data loss/);
  assert.match(rules, /Another skill or plugin in force wins for the format, procedure and documents it prescribes; Creole shapes only what it leaves open/);
  // Familiar notation only: no private decoder.
  assert.doesNotMatch(rules, /[^\x00-\x7F]/, 'ASCII only');
});

test('SKILL.md Language carries Ponytail\'s work rules and i-have-adhd\'s reply shape within 3,500 characters', () => {
  const rules = languageContext(SKILL);
  assert.ok(rules.length <= 3500, `${rules.length} characters`);
  const work = ['Read the code a change touches first', 'Take the first option that fully works: no change; this codebase\'s own helper; the standard library or platform; an installed dependency; the fewest lines', 'nobody asked for', 'Never cut validation at trust boundaries, error handling that prevents data loss, security, accessibility', 'leaves one small test', 'root cause once, in the shared code', '`shortcut: <the limit>, <when to upgrade>`', 'The shortest working diff wins: leave the code around a fix as it is'];
  const replies = ['Show only what the user needs to act', 'End every turn that changed or checked anything with three lines in this order', 'Done: issues 1-24 fixed', 'Line 1: the outcome as the user sees it, in one sentence; their asked answer leads it', '`checked:` the command and what it showed, or "not run"', '`next:` the most useful next action; "none" only when nothing is left', 'exactly as printed', 'no expected failures, details or lists unless asked', 'skipped:', 'risk:', 'At most five items, ranked', 'No preamble, recap or closing pleasantries', 'one-line offer', 'Explain in full when asked', 'Confirm destructive actions first', 'After three failed attempts, name the assumption'];
  for (const rule of [...work, ...replies]) assert.ok(rules.includes(rule), rule);
  assert.ok(rules.indexOf('### Work') < rules.indexOf('### Replies'));
});

test('graph instructions without the Language section: the fork and trigger text, never the language rules', () => {
  const graph = graphSkill(SKILL);
  assert.match(graph, /^# Creole\n/);
  for (const section of ['## Trigger evaluation', '## Classification', '## Summary generation', '### Format']) assert.ok(graph.includes(section), section);
  // Live runs: without it, every first compaction lost the test command and later runs were denied.
  assert.match(graph, /\| T \| [^\n]*exact test command/);
  assert.match(graph, /^T: [^\n]*; tests: cargo test$/m);
  // Live runs: a graph dropped a failing test the agent had seen and left alone; after the compaction it fixed it unasked.
  assert.match(graph, /\| I1… \| [^\n]*seen but not asked about[^\n]*"not requested"/);
  assert.doesNotMatch(graph, /## Language|working language|^name: creole/m);
  // memory-file compression runs only on request, so the graph's writers never read it.
  assert.ok(SKILL.includes('\n## Compression\n'));
  assert.doesNotMatch(graph, /## Compression|compress\.mjs/);
  assert.match(graph, /\nL: Golden date cases fixed\n```$/, 'the graph instructions end with the delta example');
  assert.equal(graph.includes(languageContext(SKILL).replace('# Creole language\n\n', '')), false);
  assert.equal(graphSkill(''), '');
  assert.equal(graphSkill(undefined), '');
  assert.equal(graphSkill(SKILL.replace(/\n## Summary generation\n[\s\S]*/, '\n')), '', 'a skill missing its graph instructions is unavailable');
});
