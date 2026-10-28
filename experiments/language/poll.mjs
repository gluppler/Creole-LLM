// Ask many agents the same neutral question: which working language do LLM agents share?
// usage: node experiments/language/poll.mjs <out.json> <agent>...   agent = claude:<model> | codex:<model> | omp:<openrouter model>
// Each agent runs in its own harness from an empty dir, no tools, no plugins, no project files.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

export const STATE = `Task: add retry with exponential backoff to the HTTP fetch client in src/http.ts (TypeScript, Node 22, tests in Vitest). The user's constraints, in their words: "at most 3 attempts" and "no new dependencies". Done so far: a withRetry wrapper in src/http.ts that waits 100 ms before the second attempt and doubles the wait each time. Rejected: the axios-retry package, because of the no-new-dependencies rule. Open problem: the test backoff in tests/retry.test.ts fails with "expected 3 attempts, received 1". Likely cause, not yet confirmed: the catch block in withRetry rethrows the error instead of retrying. Next step: change that catch block, then run npx vitest run retry.`;

export const POLL = `You are an LLM coding agent. Choose the working language you would use for your own reasoning, plans and notes, and for messages you send to other LLM agents (never to humans).

Goal: the fewest tokens, while any other LLM agent from any vendor (Claude, GPT, Gemini, Llama, Qwen, DeepSeek and others) reads it with no glossary or prior agreement and then acts exactly as you would. It is text. Code, commands, paths, numbers and quoted text stay exact.

Answer with exactly three parts:
NAME: the name of the language or format, in a few words.
RULES: at most 8 short bullet rules that define it.
EXAMPLE: the working state below written in your language, inside a fenced block that starts with \`\`\`state

Working state:
${STATE}`;

// Outside the repo: the codex home links the user's auth.json.
const ROOT = join(tmpdir(), 'creole-language');

function run(cmd, args, input, cwd, timeoutMs = 600000, extraEnv = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd, env: { ...process.env, CLAUDE_CODE_AUTO_COMPACT_WINDOW: '', CREOLE_MODULE: '', ...extraEnv } });
    let out = '', err = '';
    const t = setTimeout(() => p.kill('SIGTERM'), timeoutMs);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => { clearTimeout(t); resolve({ code, out, err: err.slice(-2000) }); });
    if (input != null) p.stdin.end(input); else p.stdin.end();
  });
}

// Returns { text, outputTokens, ms, error }.
export async function ask(agent, prompt) {
  const [kind, ...rest] = agent.split(':');
  const model = rest.join(':');
  const cwd = join(ROOT, 'empty');
  mkdirSync(cwd, { recursive: true });
  const t0 = Date.now();
  if (kind === 'claude') {
    const r = await run('claude', ['-p', '--setting-sources', '', '--tools', '', '--model', model, '--output-format', 'json'], prompt, cwd);
    let j = {};
    try { j = JSON.parse(r.out); } catch {}
    return { text: j.result ?? '', outputTokens: j.usage?.output_tokens ?? null, costUsd: j.total_cost_usd ?? null, ms: Date.now() - t0, error: j.is_error ? j.result : r.code ? r.err : null };
  }
  if (kind === 'codex') {
    // An own CODEX_HOME: the user's config enables plugins (ponytail) whose hooks would prime the answer.
    const home = join(ROOT, 'codex-home');
    if (!existsSync(join(home, 'auth.json'))) {
      mkdirSync(home, { recursive: true });
      symlinkSync(join(homedir(), '.codex', 'auth.json'), join(home, 'auth.json'));
      writeFileSync(join(home, 'config.toml'), 'model_reasoning_effort = "max"\n');
    }
    const last = join(cwd, `codex-last-${process.pid}-${Date.now()}.txt`);
    const r = await run('codex', ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '-m', model, '--output-last-message', last, '-'], prompt, cwd, 600000, { CODEX_HOME: home });
    const text = existsSync(last) ? readFileSync(last, 'utf8') : '';
    const tok = /tokens used\s*\n?\s*([\d,]+)/i.exec(r.out + r.err)?.[1];
    return { text, outputTokens: null, totalTokens: tok ? Number(tok.replace(/,/g, '')) : null, ms: Date.now() - t0, error: text ? null : (r.err || r.out).slice(-1500) };
  }
  if (kind === 'omp') {
    const r = await run('omp', ['-p', '--no-tools', '--no-lsp', '--no-session', '--model', `openrouter/${model}`, prompt], null, cwd);
    return { text: r.out.trim(), outputTokens: null, ms: Date.now() - t0, error: r.out.trim() ? null : r.err.slice(-1500) || `exit ${r.code}` };
  }
  throw new Error(`unknown agent kind ${kind}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [out, ...agents] = process.argv.slice(2);
  const prev = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : { prompt: POLL, answers: {} };
  // OpenRouter free models are rate limited, so omp agents run one at a time; the rest in parallel.
  const omp = agents.filter((a) => a.startsWith('omp:'));
  const other = agents.filter((a) => !a.startsWith('omp:'));
  const save = () => writeFileSync(out, JSON.stringify(prev, null, 2) + '\n');
  const one = async (a) => { const r = await ask(a, POLL); prev.answers[a] = { at: new Date().toISOString(), ...r }; save(); console.log(a, r.error ? `ERROR ${String(r.error).slice(0, 200)}` : `${r.text.length} chars, ${r.ms} ms`); };
  await Promise.all([Promise.all(other.map(one)), (async () => { for (const a of omp) await one(a); })()]);
}
