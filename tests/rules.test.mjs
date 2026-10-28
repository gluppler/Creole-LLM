// Every agent's rules file carries the skill's Language section, unedited, in that agent's format.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RULES, rulesText } from '../scripts/sync-rules.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

test('each rules file is the Language section in its agent\'s format, in sync with SKILL.md', () => {
  const text = rulesText(read('skills/creole/SKILL.md'));
  assert.match(text, /^# Creole\n\nCreole is your working language/);
  assert.match(text, /### Work\n[^]*### Replies\n/);
  for (const [path, head] of Object.entries(RULES)) assert.equal(read(path), head + text, `${path}: run node scripts/sync-rules.mjs`);
});

test('the Kimi manifest and OpenCode command point at files that exist', () => {
  const kimi = JSON.parse(read('.kimi-plugin/plugin.json'));
  assert.equal(kimi.name, 'creole');
  for (const p of [kimi.skills, kimi.systemPromptPath]) assert.ok(existsSync(join(ROOT, p)), p);
  assert.match(read('.opencode/command/creole.md'), /Use the `creole` skill/);
});

test('every host manifest names creole at 1.0.0 where it carries a version, and points at files that exist', () => {
  const version = JSON.parse(read('package.json')).version;
  for (const p of ['.devin-plugin/plugin.json', '.qoder-plugin/plugin.json', '.cursor-plugin/plugin.json', '.github/plugin/plugin.json', 'plugin.json', '.grok-plugin/marketplace.json', '.github/plugin/marketplace.json']) {
    const m = JSON.parse(read(p));
    const plugin = m.plugins?.[0] ?? m;
    assert.equal(plugin.name, 'creole', p);
    if (m.version) assert.equal(m.version, version, p);
    for (const k of ['skills', 'rules', 'source']) if (plugin[k]) assert.ok(existsSync(join(ROOT, plugin[k])), `${p}: ${k} ${plugin[k]}`);
  }
});

test('Copilot gets the rules as additionalContext at session start and nothing after; off removes them', async () => {
  const { handle } = await import('../lib/creole-hooks.mjs');
  const env = { COPILOT_PLUGIN_DATA: '/tmp/creole-copilot-test' };
  const start = handle({ hook_event_name: 'SessionStart' }, env);
  assert.match(start.additionalContext, /^# Creole language\n/);
  assert.deepEqual(handle({}, env), start, 'an unnamed sessionStart');
  assert.equal(handle({ hook_event_name: 'UserPromptSubmit', prompt: 'go' }, env), null);
  assert.equal(handle({ hook_event_name: 'SessionStart' }, { ...env, CREOLE_LANGUAGE: 'off' }), null);
});

test('Qoder, Cursor-plugin and Copilot hook files run the one hook script through each host\'s plugin root', () => {
  const qoder = JSON.parse(read('hooks/qoder-hooks.json')).hooks;
  for (const e of ['UserPromptSubmit', 'PostToolUse', 'Stop', 'PreCompact', 'SessionStart', 'SessionEnd']) assert.equal(qoder[e][0].hooks[0].command, 'node "${QODER_PLUGIN_ROOT}/hooks/creole-hook.mjs"', e);
  const cursor = JSON.parse(read('hooks/cursor-plugin-hooks.json')).hooks;
  for (const e of ['sessionStart', 'beforeSubmitPrompt', 'postToolUse', 'afterAgentResponse']) assert.equal(cursor[e][0].command, 'node "${CURSOR_PLUGIN_ROOT}/hooks/creole-hook.mjs"', e);
  assert.match(JSON.parse(read('hooks/copilot-hooks.json')).hooks.sessionStart[0].bash, /\$PLUGIN_ROOT\/hooks\/creole-hook\.mjs/);
  assert.equal(JSON.parse(read('.qoder-plugin/plugin.json')).hooks, './hooks/qoder-hooks.json');
  assert.equal(JSON.parse(read('.cursor-plugin/plugin.json')).hooks, './hooks/cursor-plugin-hooks.json');
  assert.equal(JSON.parse(read('.github/plugin/marketplace.json')).plugins[0].hooks, 'hooks/copilot-hooks.json');
});

test('OpenCode plugin: the rules appended every turn under both plugin APIs, the skill registered, none when off', async () => {
  const plugin = (await import('../.opencode/plugins/creole.mjs')).default;
  const v1 = await plugin.server();
  const out = { system: ['host prompt'] };
  await v1['experimental.chat.system.transform']({}, out);
  assert.match(out.system[0], /^host prompt\n\n# Creole language\n/);
  const cfg = {};
  await v1.config(cfg);
  assert.ok(existsSync(join(cfg.skills.paths[0], 'creole/SKILL.md')));
  const parts = [];
  await plugin.setup({ session: { hook: async (name, fn) => { assert.equal(name, 'context'); fn({ system: parts }); } } });
  assert.match(parts[0].text, /^# Creole language\n/);
  const { rules } = await import('../.opencode/plugins/creole.mjs');
  assert.equal(rules({ CREOLE_LANGUAGE: 'off' }), null);
});
