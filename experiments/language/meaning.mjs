// Meaning and payload fixtures for the Creole language, held fixed across comparison
// runs. No model is called here. Each MEANING fixture pairs a plain-English source with a Creole
// rendering that keeps its meaning, and negatives that each change one meaning-bearing element while
// keeping the labels and about the same word count, so only a check of the meaning rejects them.
// PAYLOADS must come back byte for byte; HUMAN text addressed to a person must stay full sentences.

// Each element is a predicate that a faithful rendering satisfies.
// shortcut: order is judged by position, so "B after A" reads as B first; extend before grading model paraphrases that use "after".
const inOrder = (...res) => (t) => {
  const at = res.map((re) => t.search(re));
  return at.every((i) => i >= 0) && at.every((i, k) => k === 0 || at[k - 1] < i);
};

export const MEANING = [
  {
    id: 'retry-policy',
    source: 'The cause is not confirmed yet. Retry only when the server returns 409, with at most 3 attempts, and wait 250 ms before each retry.',
    creole: 'cause: unconfirmed; retry only on 409; at most 3 attempts; wait 250 ms before retry',
    elements: {
      uncertainty: (t) => /\bunconfirmed\b|\bnot (yet )?confirmed\b/i.test(t),
      condition: (t) => /\bonly (on|when|if|for)\b[^;\n]*\b409\b/i.test(t),
      count: (t) => /\b(at most|no more than|up to)\s+(3|three)\s+attempts?\b/i.test(t),
      unit: (t) => /\b250\s?(ms|milliseconds?)\b/i.test(t),
      order: (t) => /\bwait\b[^;\n]*(\bbefore\b|\bthen\b|->)[^;\n]*\bretr/i.test(t),
    },
    negatives: [
      { breaks: 'uncertainty', text: 'cause: confirmed; retry only on 409; at most 3 attempts; wait 250 ms before retry' },
      { breaks: 'condition', text: 'cause: unconfirmed; retry also on 409; at most 3 attempts; wait 250 ms before retry' },
      { breaks: 'count', text: 'cause: unconfirmed; retry only on 409; at most 5 attempts; wait 250 ms before retry' },
      { breaks: 'unit', text: 'cause: unconfirmed; retry only on 409; at most 3 attempts; wait 250 s before retry' },
      { breaks: 'order', text: 'cause: unconfirmed; retry only on 409; at most 3 attempts; retry, then wait 250 ms' },
    ],
  },
  {
    id: 'negation-until',
    source: 'Do not delete the migration files. Keep the old schema until the backfill finishes.',
    creole: 'constraint: never delete migration files; keep old schema until backfill finishes',
    elements: {
      negation: (t) => /\b(never|do not|don't|must not)\b[^;\n.]*\bdelete\b[^;\n.]*\bmigration/i.test(t),
      condition: (t) => /\buntil\b[^;\n]*\bbackfill\b/i.test(t),
    },
    negatives: [
      { breaks: 'negation', text: 'constraint: always delete migration files; keep old schema until backfill finishes' },
      { breaks: 'condition', text: 'constraint: never delete migration files; keep old schema after backfill finishes' },
    ],
  },
  {
    id: 'source-and-quote',
    source: 'The CI log, not a local run, shows test_auth failing with "expected 200, got 401".',
    creole: 'source: CI log, not local run; test_auth fails: "expected 200, got 401"',
    elements: {
      source: (t) => /\bCI\b/.test(t) && !/^source: local/im.test(t),
      identifier: (t) => /\btest_auth\b/.test(t),
      error: (t) => t.includes('"expected 200, got 401"'),
    },
    negatives: [
      { breaks: 'source', text: 'source: local run, not CI log; test_auth fails: "expected 200, got 401"' },
      { breaks: 'identifier', text: 'source: CI log, not local run; auth test fails: "expected 200, got 401"' },
      { breaks: 'error', text: 'source: CI log, not local run; test_auth fails: "expected 200, got 403"' },
    ],
  },
  {
    id: 'limits-units',
    source: 'Please limit the uploads to 10 MiB per file and to 100 files per request.',
    creole: 'constraint: at most 10 MiB per file; at most 100 files per request',
    elements: {
      size: (t) => /\b10\s?MiB per file\b/.test(t),
      count: (t) => /\b100 files per request\b/.test(t),
    },
    negatives: [
      { breaks: 'size', text: 'constraint: at most 10 MB per file; at most 100 files per request' },
      { breaks: 'count', text: 'constraint: at most 10 MiB per file; at most 1000 files per request' },
    ],
  },
  {
    id: 'confidence',
    source: 'The failure is probably a race in the cache layer, about 70% confident; it stays unconfirmed until the stress test reproduces it.',
    creole: 'hypothesis: race in cache layer, about 70% confident; unconfirmed until stress test reproduces it',
    elements: {
      confidence: (t) => /\b70\s?%/.test(t),
      uncertainty: (t) => /\bunconfirmed\b|\bnot (yet )?confirmed\b/i.test(t),
      condition: (t) => /\buntil\b[^;\n]*\bstress test\b/i.test(t),
    },
    negatives: [
      { breaks: 'confidence', text: 'hypothesis: race in cache layer, about 90% confident; unconfirmed until stress test reproduces it' },
      { breaks: 'uncertainty', text: 'hypothesis: race in cache layer, about 70% confident; confirmed until stress test reproduces it' },
    ],
  },
  {
    id: 'action-order',
    source: 'First back up the database, then run the migration, then restart the API.',
    creole: 'next: back up database -> run migration -> restart API',
    elements: { order: inOrder(/\bback(ed)? up\b|\bbackup\b/i, /\bmigration\b/i, /\brestart\b/i) },
    negatives: [{ breaks: 'order', text: 'next: run migration -> back up database -> restart API' }],
  },
];

// The elements a text loses: [] when it keeps the fixture's meaning.
export const meaningLost = (fixture, text) => Object.entries(fixture.elements).filter(([, kept]) => !kept(text ?? '')).map(([k]) => k);

// Text that must survive byte for byte inside whatever the agent writes around it.
export const PAYLOADS = [
  { id: 'code', exact: 'if (retries >= 3) throw new RetryError(`gave up after ${retries} attempts`);', negatives: ['if (retries >= 3) throw new RetryError(`gave up after ${retries} tries`);', 'if(retries>=3) throw new RetryError(`gave up after ${retries} attempts`);'] },
  { id: 'command', exact: 'npx vitest run retry --reporter=verbose', negatives: ['npx vitest run retry', 'npx vitest run retry --reporter verbose'] },
  { id: 'identifier', exact: 'withRetryBackoff', negatives: ['with_retry_backoff', 'withRetryBackOff'] },
  { id: 'quoted-error', exact: "TypeError: Cannot read properties of undefined (reading 'id')", negatives: ['TypeError: cannot read properties of undefined (reading id)'] },
  { id: 'file', exact: '{\n  "retries": 3,\n  "delayMs": 250\n}\n', negatives: ['{"retries":3,"delayMs":250}\n', '{\n  "retries": 3,\n  "delayMs": 250,\n}\n'] },
  { id: 'commit', exact: 'Fix retry loop that rethrew on 409\n\nRetry only on 409, at most 3 attempts, waiting 250 ms between them.\n', negatives: ['fix: retry loop rethrew on 409; retry only on 409; at most 3 attempts; wait 250 ms\n'] },
  // The user asked for exactly this reply, so nothing may surround it.
  { id: 'literal', exact: 'OK: 3 of 3 checks passed', whole: true, negatives: ['ok: 3/3 checks passed', 'OK: 3 of 3 checks passed.'] },
];

// Whether output carries the payload unchanged: as the whole output for a requested literal, else inside it.
export const payloadKept = (payload, output) => (payload.whole ? output === payload.exact : String(output ?? '').includes(payload.exact));

// Text for a person: a warning, a question, prose they asked for. Full sentences, no Creole notation.
export const HUMAN = [
  { id: 'data-loss-warning', readable: 'This deletes every backup in s3://prod-backups and cannot be undone. Do you want me to continue?', terse: 'warn: delete all s3://prod-backups, irreversible -> continue?' },
  { id: 'question', readable: 'Should the retry also cover 503 responses, or only 409?', terse: 'q: retry 503 too, or 409 only?' },
  { id: 'requested-prose', readable: 'The release adds retries with backoff. Requests that fail with 409 now retry up to three times.', terse: 'release: retries + backoff; 409 -> retry, max 3' },
];

// Every sentence starts with a capital and ends with . ? or !; no arrows, semicolons, = or leading labels.
export const readable = (text) => {
  const t = String(text ?? '').trim();
  return Boolean(t) && t.split(/(?<=[.?!])\s+/).every((s) => /^[A-Z"'`]/.test(s) && /[.?!]["'`)]?$/.test(s)) &&
    !/->|;|\s!?=\s|^[a-z]\w*:\s/m.test(t);
};
