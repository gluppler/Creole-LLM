// memory-file compression on request: the protected-span checker and the backup, check and
// restore commands of skills/creole/scripts/compress.mjs, run as the agent runs them, from the project root.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { lost, main, spans } from '../skills/creole/scripts/compress.mjs';

const SCRIPT = fileURLToPath(new URL('../skills/creole/scripts/compress.mjs', import.meta.url));

const ORIGINAL = `---
name: demo
---

# Project notes

Setup
=====

This project uses Node 22.18 or newer. Run \`npm test\` before every commit, and please make sure that you read https://example.com/docs/setup.html first.

The configuration lives in config/app.json and the entry point is src/index.mjs. Requests time out after 250 ms and retry at most 3 times.

| Setting | Default |
|---|---|
| threshold | 60% |

\`\`\`sh
npm test
node --test tests/language.test.mjs
\`\`\`

1. First, you should really open README.md.
2. Then you should run the build.

Café menus cost €5, and the Zürich office keeps its notes in docs/café.md.
`;

// The prose rewritten in Creole; every protected span kept, the list renumbered.
const FAITHFUL = `---
name: demo
---

# Project notes

Setup
=====

Node 22.18 or newer. Run \`npm test\` before each commit; read https://example.com/docs/setup.html first.

Config: config/app.json; entry: src/index.mjs. Requests time out after 250 ms; at most 3 retries.

| Setting | Default |
|---|---|
| threshold | 60% |

\`\`\`sh
npm test
node --test tests/language.test.mjs
\`\`\`

- Open README.md.
- Run the build.

Café menus: €5. Zürich office notes: docs/café.md
`;

test('compress: a faithful rewrite keeps every protected span, whatever its line endings or byte order mark', () => {
  assert.deepEqual(spans(ORIGINAL).map((s) => s.kind), [
    'frontmatter', 'code block', 'heading', 'heading', 'table row', 'table row', 'table row',
    'inline code', 'URL', 'path', 'path', 'path', 'path', 'number', 'number', 'number', 'number',
  ]);
  assert.deepEqual(spans(ORIGINAL).filter((s) => s.kind === 'path' || s.kind === 'number').map((s) => s.text),
    ['config/app.json', 'src/index.mjs', 'README.md', 'docs/café.md', '22.18', '250 ms', '3', '€5'], 'the list numbering is not protected');
  assert.deepEqual(lost(ORIGINAL, FAITHFUL), []);
  const crlf = (text) => `﻿${text.replace(/\n/g, '\r\n')}`;
  assert.deepEqual(spans(crlf(ORIGINAL)), spans(ORIGINAL));
  assert.deepEqual(lost(crlf(ORIGINAL), FAITHFUL), []);
  assert.deepEqual(lost(ORIGINAL, crlf(FAITHFUL)), []);
});

test('compress: each lost protected span is named with its kind', () => {
  for (const [kind, from, to, text] of [
    ['frontmatter', 'name: demo\n', 'name: demo2\n', '---\nname: demo\n---'],
    ['code block', 'node --test tests/language.test.mjs\n`', 'node --test\n`', '```sh\nnpm test\nnode --test tests/language.test.mjs\n```'],
    ['heading', '# Project notes', '# Notes', '# Project notes'],
    ['heading', 'Setup\n=====\n', 'Setup\n', 'Setup\n====='],
    ['table row', '| threshold | 60% |', '| threshold | 60 % |', '| threshold | 60% |'],
    ['inline code', 'Run `npm test`', 'Run npm test', '`npm test`'],
    ['URL', 'docs/setup.html', 'docs/start.html', 'https://example.com/docs/setup.html'],
    ['path', 'config/app.json', 'config/app.yaml', 'config/app.json'],
    ['path', 'docs/café.md', 'docs/cafe.md', 'docs/café.md'],
    ['number', '250 ms', '250ms', '250 ms'],
    ['number', '€5', '5 euros', '€5'],
  ]) {
    assert.ok(FAITHFUL.includes(from), from);
    assert.deepEqual(lost(ORIGINAL, FAITHFUL.replace(from, to)), [{ kind, text }], `${kind}: ${from}`);
  }
  assert.deepEqual(lost(ORIGINAL, `\n${FAITHFUL}`).map((s) => s.kind), ['frontmatter'], 'the frontmatter must open the file');
  // A span kept only inside a code block is not kept in the prose.
  assert.deepEqual(lost('Read config/app.json.', 'Read:\n```\nconfig/app.json\n```'), [{ kind: 'path', text: 'config/app.json' }]);
  assert.deepEqual(lost('Limits\n\nname | max\n--- | ---\nretries | 3\n', 'Limits\n\nname | max\n--- | ---\nretries: 3\n'), [{ kind: 'table row', text: 'retries | 3' }]);
});

test('compress: the skill runs the procedure only on request, inside the project, with the bundled script', () => {
  const skill = readFileSync(new URL('../skills/creole/SKILL.md', import.meta.url), 'utf8');
  const section = /\n## Compression\n([\s\S]*?)(?=\n## |$)/.exec(skill)[1];
  assert.match(skill.split('\n---\n')[0], /Rewrite a memory or instructions file in Creole only when the user asks to compress that file/);
  for (const rule of ['Only when the user asks', 'Never on your own initiative, and never a file outside the project']) assert.ok(section.includes(rule), rule);
  for (const command of ['backup', 'check', 'restore']) assert.ok(section.includes(`node <skill>/scripts/compress.mjs ${command} <file>`), command);
  // Every kind the checker protects.
  for (const kind of ['frontmatter', 'fenced code', 'headings', 'table rows', 'inline code', 'URLs', 'paths', 'numbers with their units']) assert.ok(section.includes(kind), kind);
});

// The agent's commands in a fresh project, backups in a plugin data folder outside it.
function project() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'creole-compress-')));
  const root = join(base, 'project');
  const data = join(base, 'data');
  mkdirSync(root);
  const run = (args, env = {}) => {
    const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, PLUGIN_DATA: '', CLAUDE_PLUGIN_DATA: data, ...env } });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const backups = () => readdirSync(join(data, 'backups')).flatMap((d) => readdirSync(join(data, 'backups', d)).map((f) => join(data, 'backups', d, f)));
  return { base, root, data, run, backups, done: () => rmSync(base, { recursive: true, force: true }) };
}

test('compress: backup outside the project, check names the loss, restore gives back the original bytes', (t) => {
  const p = project();
  t.after(p.done);
  const original = Buffer.from(`﻿${ORIGINAL.replace(/\n/g, '\r\n')}`);
  const file = join(p.root, 'CLAUDE.md');
  writeFileSync(file, original);

  const backup = p.run(['backup', 'CLAUDE.md']);
  assert.equal(backup.code, 0, backup.err);
  const [saved] = p.backups();
  assert.ok(saved.startsWith(join(p.data, 'backups', 'CLAUDE.md-')), saved);
  assert.equal(backup.out, `backup: ${saved}\n`);
  assert.deepEqual(readFileSync(saved), original);

  writeFileSync(file, FAITHFUL);
  const ok = p.run(['check', 'CLAUDE.md']);
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, new RegExp(`^ok: all 17 protected spans kept; ${original.length} -> ${Buffer.byteLength(FAITHFUL)} bytes \\(\\d+% smaller\\); backup: `));

  writeFileSync(file, FAITHFUL.replace('250 ms', '250ms').replace('# Project notes', '# Notes'));
  const bad = p.run(['check', 'CLAUDE.md']);
  assert.equal(bad.code, 1);
  assert.equal(bad.out, 'lost heading: # Project notes\nlost number: 250 ms\n2 of 17 protected spans lost; repair CLAUDE.md and check again, or restore the backup\n');

  writeFileSync(file, ' \n');
  assert.deepEqual(p.run(['check', 'CLAUDE.md']), { code: 1, out: 'the rewrite of CLAUDE.md is empty; restore the backup\n', err: '' });

  const restore = p.run(['restore', 'CLAUDE.md']);
  assert.equal(restore.code, 0, restore.err);
  assert.deepEqual(readFileSync(file), original, 'byte for byte, with its byte order mark and CRLF line endings');
});

test('compress: a second backup is a new file, even in the same millisecond; the first is never overwritten, and restore takes the newest', (t) => {
  const p = project();
  t.after(p.done);
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-20T09:00:00Z') });
  t.mock.method(console, 'log', () => {});
  const env = { CLAUDE_PLUGIN_DATA: p.data };
  const file = join(p.root, 'AGENTS.md');
  writeFileSync(file, 'first version\n');
  assert.equal(main(['backup', 'AGENTS.md'], env, p.root), 0);
  writeFileSync(file, 'second version\n');
  assert.equal(main(['backup', 'AGENTS.md'], env, p.root), 0);
  assert.deepEqual(p.backups().sort().map((f) => [basename(f), readFileSync(f, 'utf8')]),
    [['2026-10-20T09-00-00.000Z-000.md', 'first version\n'], ['2026-10-20T09-00-00.000Z-001.md', 'second version\n']]);
  writeFileSync(file, 'rewrite\n');
  assert.equal(main(['restore', 'AGENTS.md'], env, p.root), 0);
  assert.equal(readFileSync(file, 'utf8'), 'second version\n');
  // A file of the same name elsewhere in the project has its own backups.
  mkdirSync(join(p.root, 'docs'));
  writeFileSync(join(p.root, 'docs', 'AGENTS.md'), 'nested\n');
  assert.equal(p.run(['check', 'docs/AGENTS.md']).code, 2);
});

test('compress: refuses a file outside the project, a link out of it or to nothing, and a backup folder inside it', (t) => {
  const p = project();
  t.after(p.done);
  writeFileSync(join(p.base, 'outside.md'), 'outside\n');
  writeFileSync(join(p.root, 'CLAUDE.md'), 'inside\n');
  symlinkSync(join(p.base, 'outside.md'), join(p.root, 'link.md'));
  symlinkSync(join(p.root, 'gone.md'), join(p.root, 'dangling.md'));
  for (const name of ['../outside.md', join(p.base, 'outside.md'), 'link.md', 'dangling.md', '.']) {
    for (const command of ['backup', 'restore']) {
      const r = p.run([command, name]);
      assert.equal(r.code, 2, `${command} ${name}`);
      assert.match(r.err, /^compress: .* is not a file inside the project .*never through a link\n$/, `${command} ${name}`);
    }
  }
  assert.equal(readFileSync(join(p.base, 'outside.md'), 'utf8'), 'outside\n');

  const within = p.run(['backup', 'CLAUDE.md'], { CLAUDE_PLUGIN_DATA: join(p.root, '.data') });
  assert.equal(within.code, 2);
  assert.match(within.err, /the backup folder .* is inside the project; set CLAUDE_PLUGIN_DATA to a folder outside it/);
  assert.deepEqual(readdirSync(p.root).sort(), ['CLAUDE.md', 'dangling.md', 'link.md'], 'nothing written inside the project');

  assert.match(p.run(['check', 'CLAUDE.md']).err, /^compress: no backup of .*CLAUDE\.md; run backup first\n$/);
  for (const args of [[], ['compress', 'CLAUDE.md'], ['check'], ['check', 'a.md', 'b.md']]) {
    assert.deepEqual(p.run(args), { code: 2, out: '', err: 'usage: node compress.mjs backup|check|restore <file>, from the project root\n' }, args.join(' '));
  }
});
