// Mutual intelligibility: each decoder agent rewrites each encoded note as plain facts, with no
// glossary; a deterministic grader checks the 14 facts of STATE. Token counts use o200k (tiktoken).
// usage: node experiments/language/decode.mjs <encodings.json> <out.json> <decoder agent>...
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { ask } from './poll.mjs';

export const DECODE = (note) => `The note below was written by an AI agent for other AI agents, not for humans. Rewrite every fact it contains as plain English sentences, one per line. Keep code, paths, numbers and quotes exact. Add nothing that is not in the note.

Note:
${note}`;

const lineWith = (text, re) => text.split('\n').filter((l) => re.test(l));
export const FACTS = {
  file: (t) => /src\/http\.ts/.test(t),
  exponentialBackoff: (t) => /exponential/i.test(t) && /back-?off/i.test(t),
  maxThree: (t) => /(at most|max(imum)?|up to|no more than|limit(ed)?( of| to)?|cap(ped)?( at)?)\s*(of\s*)?(3|three)\b|\b(3|three) attempts? (max|maximum|at most|limit)|attempts?\s*(<=|≤)\s*3/i.test(t),
  noNewDeps: (t) => /no (new|additional|extra|external) (npm )?(dependenc|package|librar|deps)|without (adding )?(any )?(new|additional) (dependenc|package|deps)|new dependenc(y|ies) (are )?(not allowed|forbidden|prohibited)|no-new-dependencies/i.test(t),
  withRetry: (t) => /withRetry/.test(t),
  wait100ms: (t) => /100\s?ms|100 millisecond/i.test(t),
  doubles: (t) => /doubl|×\s?2|\bx\s?2\b|\*\s?2|\b2x\b|twice/i.test(t),
  axiosRejected: (t) => lineWith(t, /axios-retry/).some((l) => /reject|not (be )?use|ruled out|avoid|exclud|dismiss|declin|violat|because|disallow|not allowed|can'?t|cannot|won'?t/i.test(l)),
  testFile: (t) => /tests\/retry\.test\.ts/.test(t),
  failure: (t) => /expected\s*3[^\n]{0,60}(received|got|but|only)\s*1\b/i.test(t),
  rethrowCause: (t) => /re-?throw|throws? (the error )?again/i.test(t),
  causeUnconfirmed: (t) => lineWith(t, /re-?throw|throws? (the error )?again/i).some((l) => /likely|suspect|probabl|hypothes|not (yet )?confirmed|unconfirmed|unverified|\bmay\b|might|possibl|\?|suspected|believed|appears/i.test(l)),
  nextCommand: (t) => /npx vitest run retry/.test(t),
  stack: (t) => /typescript/i.test(t) && /node(\.js)? ?22/i.test(t) && /vitest/i.test(t),
};
export const grade = (text) => Object.fromEntries(Object.entries(FACTS).map(([k, f]) => [k, f(text ?? '')]));
export const score = (g) => Object.values(g).filter(Boolean).length;

export function o200k(texts) {
  const py = 'import sys,json,tiktoken;e=tiktoken.get_encoding("o200k_base");print(json.dumps([len(e.encode(t)) for t in json.load(sys.stdin)]))';
  return JSON.parse(execFileSync('python3', ['-c', py], { input: JSON.stringify(texts), encoding: 'utf8' }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [encFile, out, ...decoders] = process.argv.slice(2);
  const encodings = JSON.parse(readFileSync(encFile, 'utf8'));
  const prev = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : { results: {} };
  const names = Object.keys(encodings);
  prev.tokens = Object.fromEntries(names.map((n, i) => [n, o200k(names.map((x) => encodings[x]))[i]]));
  prev.selfGrade = Object.fromEntries(names.map((n) => [n, score(grade(encodings[n]))]));
  const save = () => writeFileSync(out, JSON.stringify(prev, null, 2) + '\n');
  save();
  const jobs = decoders.map((d) => async () => {
    for (const n of names) {
      const key = `${d} <- ${n}`;
      if (prev.results[key]?.text) continue;
      const r = await ask(d, DECODE(encodings[n]));
      const g = grade(r.text);
      prev.results[key] = { decoder: d, encoding: n, score: score(g), grade: g, ...r };
      save();
      console.log(key, r.error ? `ERROR ${String(r.error).slice(0, 160)}` : `${score(g)}/14`);
    }
  });
  // omp decoders share OpenRouter's free rate limit: one omp decoder at a time.
  const omp = jobs.filter((_, i) => decoders[i].startsWith('omp:'));
  const other = jobs.filter((_, i) => !decoders[i].startsWith('omp:'));
  await Promise.all([...other.map((j) => j()), (async () => { for (const j of omp) await j(); })()]);
}
