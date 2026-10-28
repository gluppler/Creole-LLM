#!/usr/bin/env node
// Writes Creole's always-on rules (the Language section of skills/creole/SKILL.md) into each agent's own
// rules file, so agents without Creole's hooks still get the language, work and reply rules.
//   node scripts/sync-rules.mjs          write every file
//   node scripts/sync-rules.mjs --check  exit 1 if any file differs from the skill

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { languageContext } from '../lib/creole-graph.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const DESCRIPTION = 'Creole, a compact working language with direct work rules and short replies';

// Path and the frontmatter each agent's rules format needs; the body is the same everywhere.
export const RULES = {
  'AGENTS.md': '',
  '.agents/rules/creole.md': '',
  '.clinerules/creole.md': '',
  '.cursor/rules/creole.mdc': `---\ndescription: ${DESCRIPTION}\nglobs:\nalwaysApply: true\n---\n\n`,
  '.github/copilot-instructions.md': '',
  '.kiro/steering/creole.md': '---\ntitle: Creole\ninclusion: always\n---\n\n',
  '.qoder/rules/creole.md': '',
  '.windsurf/rules/creole.md': '',
};

export function rulesText(skill) {
  const body = languageContext(skill).replace(/^# Creole language\n/, '# Creole\n');
  return `${body.trimEnd()}\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const text = rulesText(readFileSync(join(ROOT, 'skills/creole/SKILL.md'), 'utf8'));
  const check = process.argv.includes('--check');
  const stale = [];
  for (const [path, head] of Object.entries(RULES)) {
    const file = join(ROOT, path);
    const want = head + text;
    if (check) {
      if (!existsSync(file) || readFileSync(file, 'utf8') !== want) stale.push(path);
    } else {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, want);
    }
  }
  if (stale.length) {
    console.log(`out of date: ${stale.join(', ')}; run node scripts/sync-rules.mjs`);
    process.exitCode = 1;
  }
}
