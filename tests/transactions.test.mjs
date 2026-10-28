// graph transitions checked against the meaning they must keep, apart from lint, and the
// settings policy. Adapter interleavings live beside each adapter's own mock (claude-module, creole, omp).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyUpdate, compactedContext, config, emptyGraph, extractUpdate, renderGraph, settingsNotice } from '../lib/creole-graph.mjs';

const apply = (graph, text, maxWords = Infinity) => applyUpdate(graph, extractUpdate(text), maxWords);
const delta = (pass, ...lines) => [`<!-- creole delta v2 · pass ${pass} · 2026-10-16T0${pass % 10}:00:00Z · 70000 tokens -->`, ...lines].join('\n');

// What a graph must hold, whether or not it lints: each node's exact text and links, or null for a
// node that must be gone. Returns the differences, so a schema-valid graph can still fail it.
function differences(graph, expected) {
  const out = [];
  for (const [id, want] of Object.entries(expected)) {
    const n = graph.nodes[id];
    if (want === null) { if (n) out.push(`${id} should be gone`); continue; }
    if (!n) { out.push(`${id} is missing`); continue; }
    if (want.text !== undefined && n.text !== want.text) out.push(`${id} reads ${n.text}`);
    if (want.links !== undefined && n.links.join() !== want.links.join()) out.push(`${id} links ${n.links.join()}`);
  }
  return out;
}

const LINES = [
  'T: Add retries to the HTTP client',
  'C1: "at most 3 retries"',
  'C2: "no new dependencies"',
  'B1: `src/http.ts`: client with timeouts',
  'S1: retry loop | in progress | remaining: backoff -> I1',
  'S2: docs page | not started | remaining: all',
  'I1: `test/retry.spec.ts`: expected 3 attempts, got 4',
  'H1: off-by-one in the attempt counter -> I1',
  'L: Timeouts added',
];
const full = (lines) => ['<!-- creole graph v2 · pass 1 · 2026-10-16T01:00:00Z · 70000 tokens -->', ...lines].join('\n');
const UNRELATED = { C2: { text: '"no new dependencies"' }, B1: { text: '`src/http.ts`: client with timeouts' }, S2: { text: 'docs page | not started | remaining: all', links: [] } };

test('graph transitions: a correction keeps the new words, resolution drops the issue, its hypotheses and links in any order, reopening brings them back, unrelated subtasks stay', () => {
  // The same graph written in two node orders, resolved by deltas in two line orders.
  for (const base of [LINES, [...LINES].reverse().filter((l) => !l.startsWith('T:')).concat(LINES[0])]) {
    for (const resolve of [
      ['- I1', '~ S1: retry loop | in progress | remaining: backoff', 'L: Attempt counter fixed'],
      ['~ S1: retry loop | in progress | remaining: backoff -> I1', '~ H1: off-by-one, confirmed -> I1', '- I1', 'L: Attempt counter fixed'],
    ]) {
      let { graph, errors } = apply(emptyGraph(), full(base));
      assert.deepEqual(errors, []);
      ({ graph, errors } = apply(graph, delta(2, '~ C1: "at most 2 retries"', 'L: Retry limit corrected')));
      assert.deepEqual(errors, []);
      assert.deepEqual(differences(graph, { ...UNRELATED, C1: { text: '"at most 2 retries"' }, I1: {}, H1: { links: ['I1'] }, S1: { links: ['I1'] } }), []);

      ({ graph, errors } = apply(graph, delta(3, ...resolve)));
      assert.deepEqual(errors, [], resolve.join(' / '));
      assert.deepEqual(differences(graph, { ...UNRELATED, C1: { text: '"at most 2 retries"' }, I1: null, H1: null, S1: { links: [] } }), [], resolve.join(' / '));

      const reopen = delta(4, '+ I1: `test/retry.spec.ts`: flaky under load', '+ H1: a timer shared between attempts -> I1', '~ S1: retry loop | reopened | remaining: flake -> I1', 'L: Flake reported');
      ({ graph, errors } = apply(graph, reopen));
      assert.deepEqual(errors, []);
      assert.deepEqual(differences(graph, { ...UNRELATED, C1: { text: '"at most 2 retries"' }, I1: { text: '`test/retry.spec.ts`: flaky under load' }, H1: { links: ['I1'] }, S1: { links: ['I1'] } }), []);
      assert.equal(graph.pass, 4);

      // A delta already committed, replayed, cannot advance the pass or change the graph.
      for (const again of [reopen, delta(3, ...resolve)]) {
        const replayed = apply(graph, again);
        assert.match(replayed.errors.join(), /Pass must be 5/);
        assert.equal(replayed.graph, graph);
        assert.equal(renderGraph(replayed.graph), renderGraph(graph));
      }
    }
  }
});

test('graph transitions: the meaning check is separate from lint: a valid graph that omits an unfinished subtask fails it', () => {
  const { graph } = apply(emptyGraph(), full(LINES));
  const dropped = apply(graph, full(LINES.filter((l) => !l.startsWith('S2:'))).replace('pass 1', 'pass 2'));
  assert.deepEqual(dropped.errors, [], 'it lints');
  assert.deepEqual(differences(dropped.graph, UNRELATED), ['S2 is missing']);
});

test('200 open-and-resolve transitions on a fixed active set return the resolved-node count to zero every time', () => {
  let { graph } = apply(emptyGraph(), full(['T: Keep the importer green', 'C1: "never drop a row"', 'B1: `src/import.ts`: CSV importer', 'S1: importer | in progress | remaining: edge cases', 'L: Importer started']));
  const fixed = { T: { text: 'Keep the importer green' }, C1: { text: '"never drop a row"' }, B1: {}, S1: {} };
  let pass = 1;
  for (let k = 1; k <= 200; k++) {
    let errors;
    ({ graph, errors } = apply(graph, delta(++pass, `+ I1: \`test/import.spec.ts\`: case ${k} fails`, `+ H1: cause ${k} -> I1`, '~ S1: importer | in progress | remaining: edge cases -> I1', `L: Case ${k} found`)));
    assert.deepEqual(errors, []);
    ({ graph, errors } = apply(graph, delta(++pass, '- I1', `L: Case ${k} fixed`)));
    assert.deepEqual(errors, []);
    assert.equal(Object.keys(graph.nodes).filter((id) => /^[IH]/.test(id)).length, 0, `transition ${k}`);
    assert.deepEqual(differences(graph, { ...fixed, S1: { links: [] } }), [], `transition ${k}`);
  }
  assert.equal(graph.pass, 401);
});

test('100 distinct active constraints all stay; past the word target each update says so, and past the replacement budget nothing fits', () => {
  let { graph } = apply(emptyGraph(), full(['T: Ship the billing service', 'L: Started']));
  const budget = 2000; // what a 1,000-token headroom leaves the replacement, in characters
  let warned = 0;
  let fitted = 0;
  for (let k = 1; k <= 100; k++) {
    const r = apply(graph, delta(k + 1, `+ C${k}: "rule ${k} holds for every invoice"`), 250);
    // An adapter keeps a long but valid graph after its one retry: the update is never lost.
    assert.ok(!r.errors.length || r.tooLong, r.errors.join());
    if (r.tooLong) {
      warned++;
      assert.match(r.errors[0], /the limit is 250/);
    }
    graph = r.graph;
    for (let j = 1; j <= k; j++) assert.equal(graph.nodes[`C${j}`]?.text, `"rule ${j} holds for every invoice"`);
    if (compactedContext(renderGraph(graph), [], budget)) fitted = k;
  }
  assert.ok(warned > 0 && warned < 100, `${warned} updates over the word target`);
  assert.ok(fitted > 0 && fitted < 100, `the budget holds ${fitted} constraints`);
  assert.equal(compactedContext(renderGraph(graph), [], budget), null, 'the full set no longer fits: the adapter declines, said so');
});

// ------------------------------------------------------------------ settings policy

test('config: env, then plugin option, then skill metadata, then the default; an invalid value at any level is skipped and named', () => {
  const skill = { threshold_percent: '50', headroom_tokens: '30000' };
  const option = (k, v) => ({ [`CLAUDE_PLUGIN_OPTION_${k}`]: v });
  assert.equal(config({ CREOLE_THRESHOLD_PERCENT: '70', ...option('THRESHOLD_PERCENT', '65') }, skill).threshold, 70);
  assert.equal(config(option('THRESHOLD_PERCENT', '65'), skill).threshold, 65);
  assert.equal(config({}, skill).threshold, 50);
  assert.equal(config({}).threshold, 60);
  assert.equal(config({ CREOLE_THRESHOLD_PERCENT: '100' }).threshold, 100, '100% is allowed');
  for (const bad of ['150', '100.5', '0', '-5', 'NaN', 'Infinity', '1e400', 'abc']) {
    const c = config({ CREOLE_THRESHOLD_PERCENT: bad, ...option('THRESHOLD_PERCENT', '65') }, skill);
    assert.equal(c.threshold, 65, bad);
    assert.deepEqual(c.invalid, ['CREOLE_THRESHOLD_PERCENT'], bad);
  }
  const c = config({ CREOLE_HEADROOM_TOKENS: 'x', ...option('HEADROOM_TOKENS', '-1'), CREOLE_MAX_WORDS: '0', CREOLE_CONTEXT_WINDOW_TOKENS: 'Infinity' },
    { headroom_tokens: 'Infinity', threshold_percent: '101' });
  assert.deepEqual([c.headroom, c.threshold, c.maxWords, c.window], [100000, 60, 250, 200000]);
  assert.deepEqual(c.invalid, ['threshold_percent', 'CREOLE_CONTEXT_WINDOW_TOKENS', 'CREOLE_HEADROOM_TOKENS', 'CLAUDE_PLUGIN_OPTION_HEADROOM_TOKENS', 'headroom_tokens', 'CREOLE_MAX_WORDS']);
  assert.match(settingsNotice(c), /^Creole ignored invalid settings \(threshold_percent, CREOLE_CONTEXT_WINDOW_TOKENS, .*CREOLE_MAX_WORDS\)/);
  assert.equal(settingsNotice(config({ CREOLE_THRESHOLD_PERCENT: '', ...option('THRESHOLD_PERCENT', undefined) })), '', 'unset is not invalid');
  // Only a headroom the user set (env or plugin option) is fixed; the skill's default adapts.
  assert.equal(config({}, skill).fixedHeadroom, false);
  assert.equal(config(option('HEADROOM_TOKENS', '60000')).fixedHeadroom, true);
  assert.equal(config({ CREOLE_HEADROOM_TOKENS: '60000' }).fixedHeadroom, true);
  assert.equal(config({ CREOLE_HEADROOM_TOKENS: 'x' }).fixedHeadroom, false, 'an invalid value fixes nothing');
});
