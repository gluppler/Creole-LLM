// Creole for OpenCode: a server plugin that adds Creole's rules (the Language section of
// skills/creole/SKILL.md) to every turn's system prompt and registers the skill.
//
// Add it to opencode.json:
//   { "plugin": ["/path/to/Creole-LLM/.opencode/plugins/creole.mjs"] }
//
// One default export serves both plugin APIs: V2 reads `id` and `setup`, V1 calls `server()`.
// No automatic compaction here: OpenCode gives a plugin no compaction hook Creole uses.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, languageContext } from '../../lib/creole-graph.mjs';

const SKILLS = resolve(dirname(fileURLToPath(import.meta.url)), '../../skills');

// The rules, read each turn so an edited skill applies at once; null when off or unreadable.
export function rules(env = process.env) {
  if (!config(env).language) return null;
  try {
    return languageContext(readFileSync(resolve(SKILLS, 'creole/SKILL.md'), 'utf8')) || null;
  } catch {
    return null;
  }
}

export default {
  id: 'creole',

  async setup(ctx) {
    // V2 hands over owned system parts, so push one instead of rewriting another.
    await ctx.session.hook('context', (event) => {
      const text = rules();
      if (text) event.system.push({ type: 'text', text });
    });
  },

  async server() {
    return {
      config: async (cfg) => {
        cfg.skills = cfg.skills || {};
        cfg.skills.paths = cfg.skills.paths || [];
        if (!cfg.skills.paths.includes(SKILLS)) cfg.skills.paths.push(SKILLS);
      },

      'experimental.chat.system.transform': async (_input, output) => {
        const text = rules();
        if (!text) return;
        if (output.system.length > 0) output.system[output.system.length - 1] += `\n\n${text}`;
        else output.system.push(text);
      },
    };
  },
};
