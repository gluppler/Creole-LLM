// Entry point for every Creole command hook (UserPromptSubmit, PostToolUse, Stop, PreCompact, SessionStart,
// SessionEnd).
// Must never block or break a session: any failure exits 0 with no output.

import { readFileSync } from 'node:fs';
import { handle } from '../lib/creole-hooks.mjs';

try {
  const output = handle(JSON.parse(readFileSync(0, 'utf8')), process.env);
  // PreCompact's stdout is plain text (the summarizer's extra instructions); the rest is JSON.
  if (output) process.stdout.write(typeof output === 'string' ? output : JSON.stringify(output));
} catch {
  // Fall through: no output, exit 0.
}
