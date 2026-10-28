import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { applyUpdate, emptyGraph, extractUpdate, lock, unlock } from '../lib/creole-core.mjs';
import { handle } from '../lib/creole-hooks.mjs';

test('hooks: pending checkpoints do not retrigger when token usage oscillates within the turn', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'creole-hooks-efficiency-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const transcript = join(dir, 'transcript.jsonl');
  const env = { CLAUDE_PLUGIN_DATA: dir };
  const prompt = (tokens) => {
    writeFileSync(transcript, JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: tokens } } }) + '\n');
    return handle({ session_id: 'session', hook_event_name: 'PostToolUse', transcript_path: transcript }, env);
  };
  assert.ok(prompt(130000));
  assert.equal(prompt(1000), null);
  assert.equal(prompt(130000), null);
});

test('hooks: concurrent tool completions claim only one checkpoint', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'creole-hooks-race-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const transcript = join(dir, 'transcript.jsonl');
  writeFileSync(transcript, JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 130000 } } }));
  const hook = new URL('../hooks/creole-hook.mjs', import.meta.url).href;
  // Widen the actual filesystem race, so this fails deterministically without locking.
  const script = `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
    const write = fs.writeFileSync;
    fs.writeFileSync = (path, ...args) => {
      if (String(path).includes('state.json')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
      return write(path, ...args);
    };
    syncBuiltinESMExports(); await import(${JSON.stringify(hook)});`;
  const input = JSON.stringify({ session_id: 'session', hook_event_name: 'PostToolUse', transcript_path: transcript });
  const replies = await Promise.all(Array.from({ length: 6 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, CLAUDE_PLUGIN_DATA: dir, CREOLE_MODULE: '' } });
    let output = '';
    child.stdout.on('data', (d) => { output += d; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(output) : reject(new Error(`hook exited ${code}`)));
    child.stdin.end(input);
  })));
  assert.equal(replies.filter(Boolean).length, 1);
});

test('hooks: concurrent prompts each keep their message', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'creole-hooks-capture-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const hook = new URL('../hooks/creole-hook.mjs', import.meta.url).href;
  // Widen the read-modify-write race, so this fails deterministically without locking.
  const script = `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
    const write = fs.writeFileSync;
    fs.writeFileSync = (path, ...args) => {
      if (String(path).includes('users.json')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
      return write(path, ...args);
    };
    syncBuiltinESMExports(); await import(${JSON.stringify(hook)});`;
  const prompts = Array.from({ length: 6 }, (_, i) => `Constraint ${i}: keep test ${i} green`);
  await Promise.all(prompts.map((prompt) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, CLAUDE_PLUGIN_DATA: dir, CREOLE_MODULE: '' } });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`hook exited ${code}`)));
    child.stdin.end(JSON.stringify({ session_id: 'session', hook_event_name: 'UserPromptSubmit', prompt }));
  })));
  const kept = JSON.parse(readFileSync(join(dir, 'sessions/session/users.json'), 'utf8'));
  assert.deepEqual([...kept].sort(), [...prompts].sort());
  assert.equal(existsSync(join(dir, 'sessions/session/gap.json')), false);
});

test('hooks: two replies saving the same delta at once commit it once; the second is checked against the graph the first saved', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'creole-hooks-commit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const graph = '<!-- creole graph v2 · pass 1 · 2026-10-16T01:00:00Z · 70000 tokens -->\nT: Build export\nS1: CSV writer | in progress | remaining: quoting\nL: Read source';
  const delta = '<!-- creole delta v2 · pass 2 · 2026-10-16T02:00:00Z · 71000 tokens -->\n- S1\n+ B1: `src/csv.ts`: CSV writer with quoting\nL: CSV writer done';
  const sessionDir = join(dir, 'sessions/session');
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, 'graph.json'), JSON.stringify(applyUpdate(emptyGraph(), extractUpdate(graph)).graph));
  const hook = new URL('../hooks/creole-hook.mjs', import.meta.url).href;
  // Widen the read-apply-write race, so this fails deterministically without the session lock.
  const script = `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
    const write = fs.writeFileSync;
    fs.writeFileSync = (path, ...args) => {
      if (String(path).includes('graph.json')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
      return write(path, ...args);
    };
    syncBuiltinESMExports(); await import(${JSON.stringify(hook)});`;
  const replies = await Promise.all([0, 1].map(() => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, CLAUDE_PLUGIN_DATA: dir, CREOLE_MODULE: '' } });
    let output = '';
    child.stdout.on('data', (d) => { output += d; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(output) : reject(new Error(`hook exited ${code}`)));
    child.stdin.end(JSON.stringify({ session_id: 'session', hook_event_name: 'Stop', last_assistant_message: delta }));
  })));
  assert.deepEqual(replies.map((r) => (r ? JSON.parse(r).systemMessage.match(/pass \d/)[0] : null)).sort(), [null, 'pass 2']);
  const log = readFileSync(join(sessionDir, 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(log.map((e) => [e.kind, e.pass]), [['delta', 2]]);
});

test('hooks: a live session lock is skipped and an abandoned lock recovers', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'creole-hooks-lock-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const transcript = join(dir, 'transcript.jsonl');
  writeFileSync(transcript, JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 130000 } } }));
  const lock = join(dir, 'sessions/session/users.lock');
  mkdirSync(lock, { recursive: true });
  const input = { session_id: 'session', hook_event_name: 'PostToolUse', transcript_path: transcript };
  const env = { CLAUDE_PLUGIN_DATA: dir };
  assert.equal(handle(input, env), null);
  const old = new Date(Date.now() - 31000);
  utimesSync(lock, old, old);
  assert.ok(handle(input, env)?.hookSpecificOutput.additionalContext);
});

test('lock: one hook at a time removes an abandoned lock; a dead stealer is cleared', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'creole-lock-steal-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const held = join(dir, 'users.lock');
  const old = new Date(Date.now() - 31000);
  mkdirSync(held);
  utimesSync(held, old, old);
  // Another hook is removing it now: this one neither takes the lock nor deletes it.
  mkdirSync(`${held}.steal`);
  assert.equal(lock(held), false);
  assert.ok(existsSync(held), 'the lock another hook is stealing stays');
  // That stealer died: its steal lock is old too, and it is cleared, then the abandoned lock is taken.
  utimesSync(`${held}.steal`, old, old);
  assert.equal(lock(held, 200), true);
  assert.ok(!existsSync(`${held}.steal`));
  // Taken, the lock is fresh, so a second hook waits instead of removing it.
  assert.equal(lock(held), false);
  unlock(held);
  assert.ok(!existsSync(held));
});

test('hooks: long tool loops trigger once without replacing tool results', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'creole-tool-trigger-'));
  t.after(() => rmSync(dir, { recursive: true }));
  const transcript = join(dir, 'transcript.jsonl');
  writeFileSync(transcript, JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 130000 } } }));
  const input = { session_id: 'session', hook_event_name: 'PostToolUse', transcript_path: transcript };
  const result = handle(input, { CLAUDE_PLUGIN_DATA: dir });
  assert.equal(result?.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(result.hookSpecificOutput.additionalContext, /full creole graph/);
  assert.deepEqual(Object.keys(result), ['hookSpecificOutput']);
  assert.equal(handle(input, { CLAUDE_PLUGIN_DATA: dir }), null);
});

test('hooks: Codex compatibility aliases do not cause warning messages', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'creole-aliases-'));
  t.after(() => rmSync(dir, { recursive: true }));
  const graph = '<!-- creole graph v2 · pass 1 · 2026-10-11T00:00:00Z · 0 tokens -->\nT: Build export\nL: Read source';
  assert.equal(handle({ session_id: 'session', hook_event_name: 'Stop', last_assistant_message: graph },
    { PLUGIN_DATA: dir, CLAUDE_PLUGIN_DATA: dir }), null);
});
