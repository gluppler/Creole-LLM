// Creole core for Node adapters (the Claude Code / Codex command hooks and the omp extension):
// reading token usage from agent logs, plus per-session state and graph files. The trigger rule,
// config and session graph are pure and live in creole-graph.mjs, re-exported here.

import { spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  checkGraph,
  codebaseMap,
  config as baseConfig,
  listedPaths,
  MAP_BYTES,
  MAP_LIST,
  MAP_MS,
  mapSources,
  MAX_SESSION_BYTES,
  projectContext,
  redactSecrets,
  skillMetadata,
  utf8Length,
  walkInto,
} from './creole-graph.mjs';

export * from './creole-graph.mjs';

export function readSkill() {
  try {
    return readFileSync(new URL('../skills/creole/SKILL.md', import.meta.url), 'utf8');
  } catch {
    return '';
  }
}

// The pure config, with SKILL.md's frontmatter defaults. Shadows the re-exported one.
export function config(env) {
  return baseConfig(env, skillMetadata(readSkill()));
}

// Scan backwards in chunks; a tool result can push usage beyond one chunk.
const TAIL_BYTES = 512 * 1024;

export function readTail(path, bytes = TAIL_BYTES) {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - bytes - 1);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString('utf8');
    // Read one preceding byte so a line beginning exactly at the limit survives.
    if (size <= bytes) return text;
    const newline = text.indexOf('\n');
    return newline < 0 ? '' : text.slice(newline + 1);
  } finally {
    closeSync(fd);
  }
}

// Latest context size from a Claude Code transcript or a Codex rollout log.
// Returns { tokens, window } (window null when the log does not say), or null when
// unknown, including right after a compaction, before a fresh usage record exists.
export function contextUsage(jsonlText) {
  return scanUsage(jsonlText.split('\n')) ?? null;
}

// undefined means keep looking; null is a compaction boundary and stops the search.
function scanUsage(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].toString();
    // Skip bulky tool output before parsing; escaped JSON keys still need decoding.
    if (!/usage|compact|\\u/.test(line)) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!e || typeof e !== 'object') continue;

    // Claude Code
    if (e.type === 'system' && e.subtype === 'compact_boundary') return null;
    if (e.type === 'assistant' && !e.isSidechain && e.message?.usage && e.message.model !== '<synthetic>') {
      const u = e.message.usage;
      // Same input-only formula as the statusline's used_percentage.
      const counts = [u.input_tokens ?? 0, u.cache_creation_input_tokens ?? 0, u.cache_read_input_tokens ?? 0];
      if (!counts.every((n) => Number.isSafeInteger(n) && n >= 0)) continue;
      return { tokens: counts.reduce((a, b) => a + b, 0), window: null };
    }

    // Codex: cached_input_tokens is already part of input_tokens.
    // shortcut: 'compacted' item type read from the Codex binary's strings, not a live log; confirm on first Codex
    // fixture.
    if (e.type === 'compacted') return null;
    if (e.type === 'event_msg' && e.payload?.type === 'token_count' && e.payload.info?.last_token_usage) {
      const info = e.payload.info;
      const tokens = info.last_token_usage.input_tokens;
      if (!Number.isSafeInteger(tokens) || tokens < 0) continue;
      const window = info.model_context_window;
      return { tokens, window: Number.isSafeInteger(window) && window > 0 ? window : null };
    }
  }
}

export const readContextUsage = (path) => scanBack(path, (line) => scanUsage([line]));

// Codex: the rollout's last compaction, as its window_id ('' when it has none), or null when it has
// none or, with sinceStart, when Creole's last session-start text (the language, or a restore) is
// newer, so the thread's context still holds it; quotes in other roles do not count.
export const lastCompaction = (path, sinceStart) =>
  scanBack(path, (line) => {
    const text = line.toString();
    if (!/compacted|# Creole language|\\u/.test(text)) return undefined;
    let e;
    try {
      e = JSON.parse(text);
    } catch {
      return undefined;
    }
    if (e?.type === 'compacted') return typeof e.payload?.window_id === 'string' ? e.payload.window_id : '';
    const p =
      sinceStart && e?.type === 'response_item' && e.payload?.type === 'message' && e.payload.role === 'developer'
        ? e.payload
        : null;
    return p &&
      Array.isArray(p.content) &&
      p.content.some((c) => /^(?:# Creole language|CREOLE: the session was compacted)/.test(c?.text ?? ''))
      ? null
      : undefined;
  }) ?? null;

// The first answer scan gives for a log's lines, newest first (undefined: keep looking), or null.
function scanBack(path, scan) {
  const fd = openSync(path, 'r');
  try {
    let offset = fstatSync(fd).size;
    let parts = [];
    while (offset > 0) {
      const size = Math.min(offset, TAIL_BYTES);
      offset -= size;
      const chunk = Buffer.alloc(size);
      const read = readSync(fd, chunk, 0, size, offset);
      if (read !== size) return null; // the transcript changed underneath the read
      let end = size;
      for (let newline = chunk.lastIndexOf(10); newline >= 0; newline = end ? chunk.lastIndexOf(10, end - 1) : -1) {
        const piece = chunk.subarray(newline + 1, end);
        const line = parts.length ? Buffer.concat([piece, ...parts.reverse()]) : piece;
        const result = scan(line);
        if (result !== undefined) return result;
        parts = [];
        end = newline;
      }
      if (end) parts.push(chunk.subarray(0, end));
    }
    // Decode only complete records, including UTF-8 characters split across chunks.
    return scan(Buffer.concat(parts.reverse())) ?? null;
  } finally {
    closeSync(fd);
  }
}

export function dataDir(env) {
  return env.CLAUDE_PLUGIN_DATA || env.PLUGIN_DATA || join(homedir(), '.creole');
}

// session_id comes from the agent; it becomes a path segment, so reject anything that could traverse.
export function sessionDir(base, sessionId) {
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/.test(sessionId)) return null;
  return join(base, 'sessions', sessionId);
}

// A JSON file Creole wrote: undefined when there is none. Throws when it is unreadable, damaged or
// over max bytes (checked before it is read), which callers keep apart from an absent one.
export function readJson(path, max = MAX_SESSION_BYTES) {
  let fd;
  try {
    fd = openSync(path, 'r');
  } catch (e) {
    if (e.code === 'ENOENT') return undefined;
    throw e;
  }
  try {
    if (fstatSync(fd).size > max) throw new Error(`over the ${max / 1024} KiB limit`);
    return JSON.parse(readFileSync(fd, 'utf8'));
  } finally {
    closeSync(fd);
  }
}

// Past max bytes, nothing is written.
export function writeJson(path, value, max = MAX_SESSION_BYTES) {
  const text = JSON.stringify(value);
  if (utf8Length(text) > max) throw new Error(`over the ${max / 1024} KiB limit`);
  writeText(path, text);
}

// Whole or not at all: a copy, then a rename over the file, so a writer cut off leaves the last
// complete file (and its copy, which says so).
// shortcut: no fsync, so this holds when a process dies, not when the machine does; add one if that matters.
function writeText(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const copy = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(copy, text);
    renameSync(copy, path);
  } catch (e) {
    try {
      rmSync(copy, { force: true });
    } catch {}
    throw e;
  }
}

// A session's messages, graph and state share MAX_SESSION_BYTES (its log aside). A message leaves
// the last 8 KiB to the graph and state, so a session full of messages still saves its graph.
const RESERVE_BYTES = 8 * 1024;
// Every session's files together, logs and markers included (docs/runtime-design.md, privacy and retention).
const MAX_ALL_BYTES = 3 * 1024 * 1024;
// A session that ended and was then untouched this long goes when a file next grows: lazy cleanup, not timed erasure.
const IDLE_MS = 30 * 86400000;

// One file of the session's record, whole, or nothing when it grows and the record would pass its
// cap, or every session's files 3 MiB. A write that shrinks a file is never refused. Past 3 MiB only
// the markers (gap.json, ended.json) are written: refusing one would hide a gap or keep a session forever.
// shortcut: two sessions growing in the same instant can both pass the 3 MiB check, overshooting by their own writes;
// lock sessions/ if that matters.
function writeRecord(dir, file, text, max = MAX_SESSION_BYTES) {
  mkdirSync(dir, { recursive: true });
  const size = utf8Length(text);
  if (size > fileSize(join(dir, file))) {
    if (size + bytesIn(dir, file, 'log.jsonl') > max)
      throw new Error(`the session's record would pass its ${MAX_SESSION_BYTES / 1024} KiB limit`);
    if (size + bytesIn(dir, file) + sweep(dir) > MAX_ALL_BYTES)
      throw new Error(`over the ${MAX_ALL_BYTES / 1048576} MiB limit for all sessions`);
  }
  writeText(join(dir, file), text);
}

function fileSize(path) {
  try {
    return statSync(path).size;
  } catch (e) {
    if (e.code === 'ENOENT') return 0;
    throw e;
  }
}

// The bytes in a session's files, but the named ones and the copies of writes in progress.
function bytesIn(dir, ...except) {
  let n = 0;
  for (const f of readdirSync(dir)) {
    if (except.includes(f) || f.endsWith('.tmp')) continue;
    try {
      const st = statSync(join(dir, f));
      if (st.isFile()) n += st.size;
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
  return n;
}

// Removes the other sessions that have expired and returns the bytes the rest hold. Only a session
// under a sessions/ directory is swept, and only directories there.
function sweep(dir) {
  const parent = dirname(dir);
  if (basename(parent) !== 'sessions') return 0;
  let total = 0;
  for (const e of readdirSync(parent, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name === basename(dir)) continue;
    const path = join(parent, e.name);
    try {
      if (!(expired(path) && remove(path))) total += bytesIn(path);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    } // another session removed it meanwhile
  }
  return total;
}

// Ended (the host's SessionEnd) and untouched for 30 days since, with a record this version can read.
// Age alone proves nothing: a session that never ended may still run, or was killed, and is kept;
// so is one a newer version wrote, or one damaged.
function expired(path) {
  if (!existsSync(join(path, 'ended.json'))) return false;
  const old = Date.now() - IDLE_MS;
  return (
    readdirSync(path, { withFileTypes: true }).every(
      (f) => f.isDirectory() || statSync(join(path, f.name)).mtimeMs < old,
    ) &&
    loadUsers(path) !== null &&
    (!existsSync(join(path, 'graph.json')) || loadGraph(path) !== null)
  );
}

// Under the session's lock, so a resume (which takes the end marker off under it) and a removal
// never interleave; a session whose lock another hook holds stays.
function remove(path) {
  const held = join(path, 'users.lock');
  if (!lock(held)) return false;
  try {
    if (!expired(path)) return false;
    rmSync(path, { recursive: true, force: true });
    return true;
  } finally {
    unlock(held);
  }
}

// Every hooks file gives a hook 10 s before the host kills it, so a lock this old has no live owner.
const ABANDONED_MS = 30000;

// Takes a lock (a directory) for one hook process, waiting up to wait ms while another hook holds
// it; false when it stays held.
export function lock(path, wait = 0) {
  const end = Date.now() + wait;
  for (;;) {
    try {
      mkdirSync(path);
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    try {
      if (Date.now() - statSync(path).mtimeMs > ABANDONED_MS) {
        rmdirSync(path);
        continue;
      }
    } catch {}
    if (Date.now() >= end) return false;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}

export function unlock(path) {
  try {
    rmdirSync(path);
  } catch {}
}

export function loadState(dir) {
  try {
    return { armed: true, pending: false, ...readJson(join(dir, 'state.json')) };
  } catch {
    return { armed: true, pending: false };
  }
}

// pending: false is left out (loadState's default), so ending a request never grows the file or is refused at capacity.
export function saveState(dir, state) {
  writeRecord(dir, 'state.json', JSON.stringify({ ...state, pending: state.pending || undefined }));
}

// graph.json is re-injected into the agent's context, so anything that isn't a well-formed graph is ignored.
export function loadGraph(dir) {
  try {
    return checkGraph(readJson(join(dir, 'graph.json')));
  } catch {
    return null;
  }
}

// Saves the graph and logs the update; a log that fails costs only its record.
export function saveGraph(dir, graph, update) {
  writeRecord(dir, 'graph.json', JSON.stringify(graph));
  // A graph's 0 tokens is the header's placeholder for an unknown count, not a measured zero.
  try {
    logEvent(dir, {
      pass: graph.pass,
      time: graph.time,
      tokens: graph.tokens || null,
      kind: update.kind,
      update: update.text,
    });
  } catch {}
}

const LOG_RECORDS = 50;
const LOG_BYTES = 2048;

// log.jsonl, the session's diagnostic log (never injected): its last 50 records of at most 2 KiB. A
// record past that loses its update text, or goes, as do the longer lines older versions wrote.
// shortcut: no lock, so two hooks logging at once can lose one record; the log is diagnostic only.
export function logEvent(dir, entry) {
  const { update, ...rest } = entry;
  const line = [entry, rest].map((e) => JSON.stringify(e)).find((l) => utf8Length(l) <= LOG_BYTES);
  if (!line) return;
  const path = join(dir, 'log.jsonl');
  const kept = existsSync(path)
    ? readTail(path, LOG_RECORDS * (LOG_BYTES + 1))
        .split('\n')
        .filter((l) => l && utf8Length(l) <= LOG_BYTES)
    : [];
  writeRecord(dir, 'log.jsonl', [...kept.slice(1 - LOG_RECORDS), line, ''].join('\n'), Infinity);
}

// The user's messages this session, oldest first, redacted, and [] before the first; they come back
// whole after compaction. null when the record is one this version cannot use (damaged, another
// version's, over the cap): it is then neither restored nor overwritten.
// Redacted again on load: an older version's patterns missed some credentials.
export function loadUsers(dir) {
  let users;
  try {
    users = readJson(join(dir, 'users.json'));
  } catch {
    return null;
  }
  if (users === undefined) return [];
  return Array.isArray(users) && users.every((t) => typeof t === 'string') ? users.map(redactSecrets) : null;
}

// Adds one message, whole or not at all, one hook at a time. When it can't, the gap goes on record
// before it throws, so no restore calls the messages complete. Past the 3 MiB for every session, a
// message is refused; no live session goes to make room.
export function addUser(dir, text) {
  const held = join(dir, 'users.lock');
  try {
    mkdirSync(dir, { recursive: true });
    // Another hook holds it for one write; the host's 10 s leave time to wait.
    if (!lock(held, 5000)) throw new Error('another hook kept the session busy');
    try {
      // A copy left behind is a write that was cut off, and its message is lost.
      const copies = readdirSync(dir).filter(isUsersCopy);
      if (copies.length) markGap(dir);
      for (const f of copies) rmSync(join(dir, f), { force: true });
      const users = loadUsers(dir);
      if (!users) throw new Error('the stored messages are damaged or from another version');
      writeRecord(
        dir,
        'users.json',
        JSON.stringify([...users, redactSecrets(text)]),
        MAX_SESSION_BYTES - RESERVE_BYTES,
      );
    } finally {
      unlock(held);
    }
  } catch (e) {
    try {
      markGap(dir);
    } catch {}
    throw e;
  }
}

// Whether some of this session's messages were never kept: a write refused, failed or cut off.
export function hasGap(dir) {
  try {
    return existsSync(join(dir, 'gap.json')) || readdirSync(dir).some(isUsersCopy);
  } catch {
    return false;
  }
}

const isUsersCopy = (f) => /^users\.json\.\d+\.tmp$/.test(f);

// Labels the session's messages incomplete, from the first gap's time for the rest of the session.
export function markGap(dir) {
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(join(dir, 'gap.json'), JSON.stringify({ time: new Date().toISOString() }), { flag: 'wx' });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
}

// The host's SessionEnd: the session may expire once untouched for 30 days. A session with no record
// gets no marker; one that never ends (killed) is kept until removed by hand.
export function endSession(dir) {
  if (existsSync(dir)) writeFileSync(join(dir, 'ended.json'), JSON.stringify({ time: new Date().toISOString() }));
}

// A resume takes the end marker off under the session's lock, so a cleanup that has not removed the
// session by then no longer can. With no record of its messages (expired, or Creole installed since),
// the session is incomplete, not empty; so is one the cleanup removed meanwhile.
export function resumeSession(dir) {
  const held = join(dir, 'users.lock');
  try {
    mkdirSync(dir, { recursive: true });
    if (!lock(held, 5000)) throw new Error('another hook kept the session busy');
    try {
      rmSync(join(dir, 'ended.json'), { force: true });
      if (loadUsers(dir)?.length === 0) markGap(dir);
    } finally {
      unlock(held);
    }
  } catch (e) {
    try {
      markGap(dir);
    } catch {}
    throw e;
  }
}

// The project a session works in, for its codebase map: the directory's real path, or null when the wiki is
// off or there is no directory. Nothing of the project is stored.
// shortcut: the root is the session's directory, not its repository's top, so a subdirectory maps only itself.
export function projectRoot(env, cwd) {
  if (!config(env).wiki || typeof cwd !== 'string' || !cwd) return null;
  try {
    return realpathSync(cwd);
  } catch {
    return null;
  }
}

// The project block (projectContext's) with the codebase map of the project at root; '' for none (null).
export function projectBlock(root) {
  return root ? projectContext(scanProject(root).map) : '';
}

// The codebase map of the project at root, within MAP_MS: what is not done by then is left out.
export function scanProject(root) {
  const until = Date.now() + MAP_MS;
  return { map: projectMap(root, projectFiles(root, until), until) };
}

// The project's files as paths from root: git's listing (tracked, and untracked but not ignored), else
// a walk that skips hidden, vendored, generated and test folders and follows no link; at most MAP_LIST,
// and nothing listed after until (ms). core.fsmonitor is off: a repository's config could otherwise
// have git run a program of its choosing.
export function projectFiles(root, until) {
  const git = spawnSync(
    'git',
    ['-c', 'core.fsmonitor=false', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: Math.max(1, until - Date.now()),
      maxBuffer: MAP_LIST * 512,
    },
  );
  const listed = listedPaths(git.stdout);
  if (listed.length) return listed;
  // No git, no repository, or a folder git ignores or does not track yet: it lists nothing.
  const out = [];
  const walk = (rel) => {
    let entries = [];
    try {
      entries = readdirSync(rel ? join(root, rel) : root, { withFileTypes: true });
    } catch {}
    for (const e of entries) {
      if (out.length >= MAP_LIST || Date.now() > until) return;
      const path = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (walkInto(path)) walk(path);
      } else if (e.isFile()) out.push(path);
    }
  };
  walk('');
  return out;
}

// The map (codebaseMap's) from the start of each of mapSources' files read by until (ms). A link is
// not read: it could lead out of the project, or to a pipe that never ends.
function projectMap(root, paths, until) {
  const files = [];
  for (const p of mapSources(paths)) {
    if (Date.now() > until) break;
    try {
      if (lstatSync(join(root, p)).isFile()) files.push([p, readStart(join(root, p), MAP_BYTES)]);
    } catch {}
  }
  return codebaseMap(files);
}

function readStart(path, bytes) {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    return buf.toString('utf8', 0, readSync(fd, buf, 0, bytes, 0));
  } finally {
    closeSync(fd);
  }
}
