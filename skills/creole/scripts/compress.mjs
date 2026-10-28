#!/usr/bin/env node
// Creole's memory-file compression helper (SKILL.md, Compression). Run from the project root:
//   node compress.mjs backup <file>    copy the file outside the project before the rewrite
//   node compress.mjs check <file>     name each protected span the rewrite lost from the newest backup
//   node compress.mjs restore <file>   put the newest backup's bytes back
// Node's standard library only, so the skill folder also works on its own.

import { createHash } from 'node:crypto';
import {
  constants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Compared with LF line endings and without a byte order mark.
const normalize = (text) => String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n');

const FENCE = /^\s*(`{3,}|~{3,})/;
const ATX = /^ {0,3}#{1,6}(?:[ \t]|$)/;
const UNDERLINE = /^ {0,3}(?:=+|-+)[ \t]*$/;
const NOT_SETEXT = /^\s*(?:[-*+>|#]|\d+[.)])(?:\s|$)/; // a list item, quote, table or heading line is no setext title
const DELIMITER = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?\s*$/;
const W = String.raw`\p{L}\p{M}\p{N}_`; // a word character in any script, so a non-ASCII path is protected whole
const INLINE = {
  'inline code': /(?<!`)(`+)(?!`)[^\n]*?[^`\n]\1(?!`)/g,
  URL: /\b(?:https?|ftp|file):\/\/[^\s<>()[\]{}"'`]+|\bmailto:[^\s<>()[\]{}"'`]+/g,
  path: new RegExp(
    String.raw`(?<![${W}.~@+/\\:-])(?:[A-Za-z]:)?[${W}.~@+-]*(?:[/\\][${W}.~@+-]+)+[/\\]?|(?<![${W}./\\-])[${W}-]{2,}(?:\.[${W}-]+)*\.[A-Za-z]\w{0,9}(?![${W}/\\-])`,
    'gu',
  ),
  // shortcut: a fixed list of units after a space; add one when a memory file's unit goes unprotected.
  number:
    /(?<![\p{L}\p{N}_.])(?:[-+](?=\d))?[$€£]?[vV]?\d+(?:[.,:/-]\d+)*(?:[\p{L}%°µ]+|[  ]?(?:%|‰|°[CF]?|[kKMGTP]i?B|bytes?|bits?|[nuµ]s|ms|s|secs?|seconds?|mins?|minutes?|h|hours?|days?|weeks?|months?|years?|[kMG]?Hz|px|em|rem|pt|tokens?|words?|characters?|chars?|lines?|files?|x)(?![\p{L}\p{N}_]))?/gu,
};
const trimmed = (span) => span.replace(/\.+$/, '');

// The spans of a memory file a rewrite must keep byte for byte, distinct, as { kind, text }: the
// frontmatter, fenced code blocks, headings and table rows whole, then inline code, URLs, paths and
// numbers with their units in the remaining text. An ordered list's numbering is not protected.
export function spans(text) {
  const lines = normalize(text).split('\n');
  const rest = [...lines];
  const found = new Map();
  const add = (kind, span) => {
    if (span.trim()) found.set(`${kind}\n${span}`, { kind, text: span });
  };
  const take = (kind, from, to) => {
    add(kind, lines.slice(from, to + 1).join('\n'));
    rest.fill('', from, to + 1);
  };
  if (lines[0] === '---') {
    const end = lines.findIndex((l, i) => i > 0 && (l === '---' || l === '...'));
    if (end > 0) take('frontmatter', 0, end);
  }
  for (let i = 0; i < lines.length; i++) {
    const open = rest[i] && FENCE.exec(rest[i]);
    if (!open) continue;
    const close = new RegExp(`^\\s*\\${open[1][0]}{${open[1].length},}\\s*$`);
    let end = i + 1;
    while (end < lines.length && !close.test(lines[end])) end++;
    take('code block', i, Math.min(end, lines.length - 1));
    i = end;
  }
  let table = false;
  for (let i = 0; i < lines.length; i++) {
    if (!rest[i].trim()) {
      table = false;
      continue;
    }
    if (ATX.test(rest[i])) take('heading', i, i);
    else if (rest[i + 1] && UNDERLINE.test(rest[i + 1]) && !NOT_SETEXT.test(rest[i])) take('heading', i, ++i);
    else {
      if (!table && rest[i].includes('|') && DELIMITER.test(rest[i + 1] ?? '')) table = true;
      if (table && !rest[i].includes('|')) table = false;
      if (table || /^\s*\|/.test(rest[i])) take('table row', i, i);
    }
  }
  // Masked in turn, so a URL's digits are not also a number. Not a list's numbering either.
  let prose = rest.join('\n').replace(/^(\s*)\d+[.)](?=\s)/gm, '$1');
  for (const [kind, pattern] of Object.entries(INLINE)) {
    prose = prose.replace(pattern, (m) => {
      add(kind, kind === 'path' || kind === 'URL' ? trimmed(m) : m);
      return ' ';
    });
  }
  return [...found.values()];
}

// The protected spans of original that rewrite lost: a block or line kind must stand as whole lines (a
// heading or table row ignores trailing spaces), the frontmatter must open the file, and an inline span
// must be one the same pattern finds in the rewrite outside its code blocks.
export function lost(original, rewrite) {
  const after = normalize(rewrite);
  const lines = `\n${after}\n`;
  const ends = `\n${after
    .split('\n')
    .map((l) => l.trimEnd())
    .join('\n')}\n`;
  const code = spans(after)
    .filter((s) => s.kind === 'code block')
    .map((s) => s.text);
  const outside = code.reduce((text, block) => text.replace(block, ' '), after);
  const inline = Object.fromEntries(
    Object.entries(INLINE).map(([kind, pattern]) => [
      kind,
      new Set([...outside.matchAll(pattern)].map((m) => (kind === 'path' || kind === 'URL' ? trimmed(m[0]) : m[0]))),
    ]),
  );
  return spans(original).filter(({ kind, text }) => {
    if (kind === 'frontmatter') return !`${after}\n`.startsWith(`${text}\n`);
    if (kind === 'code block') return !lines.includes(`\n${text}\n`);
    if (kind === 'heading' || kind === 'table row')
      return !ends.includes(
        `\n${text
          .split('\n')
          .map((l) => l.trimEnd())
          .join('\n')}\n`,
      );
    return !inline[kind].has(text);
  });
}

const dataDir = (env) => env.CLAUDE_PLUGIN_DATA || env.PLUGIN_DATA || join(homedir(), '.creole');
const inside = (root, p) => {
  const r = relative(root, p);
  return r === '' || (r.split(sep)[0] !== '..' && !isAbsolute(r));
};
// A path with its links resolved as far as it exists.
const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return dirname(p) === p ? p : join(real(dirname(p)), basename(p));
  }
};

// The file's real path, which must lie inside the project root: a link that leads out, or nowhere, is refused.
function target(root, abs, name) {
  let file = null;
  try {
    file = realpathSync(abs);
  } catch {
    try {
      lstatSync(abs);
    } catch {
      file = join(real(dirname(abs)), basename(abs));
    }
  }
  if (!file || file === root || !inside(root, file))
    throw new Error(
      `${name} is not a file inside the project ${root}; Creole compresses only files inside it, never through a link`,
    );
  return file;
}

// One folder of backups per file, outside the project, named after the file and a hash of its path.
function folder(env, root, file, create) {
  const dir = resolve(
    root,
    dataDir(env),
    'backups',
    `${basename(file)}-${createHash('sha256').update(file).digest('hex').slice(0, 12)}`,
  );
  if (inside(root, real(dir)))
    throw new Error(`the backup folder ${dir} is inside the project; set CLAUDE_PLUGIN_DATA to a folder outside it`);
  if (create) mkdirSync(dir, { recursive: true });
  return dir;
}

const STAMP = /^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.\d{3}Z-\d{3}/;

function newest(env, root, file) {
  const dir = folder(env, root, file, false);
  let names = [];
  try {
    names = readdirSync(dir)
      .filter((n) => STAMP.test(n))
      .sort();
  } catch {}
  if (!names.length) throw new Error(`no backup of ${file}; run backup first`);
  return join(dir, names.at(-1));
}

// A new file each time, never one that exists: the time, then a counter within the same millisecond.
function backup(env, root, file) {
  if (!statSync(file).isFile()) throw new Error(`${file} is not a regular file`);
  const dir = folder(env, root, file, true);
  const stamp = new Date().toISOString().replace(/:/g, '-');
  for (let n = 0; n < 1000; n++) {
    const to = join(dir, `${stamp}-${String(n).padStart(3, '0')}${extname(file)}`);
    try {
      copyFileSync(file, to, constants.COPYFILE_EXCL);
      return to;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
  throw new Error(`no free backup name in ${dir}`);
}

const shown = (text) => (text.includes('\n') ? `${text.split('\n').slice(0, 2).join(' ')} ...` : text);

export function main(argv, env, cwd) {
  const [command, name, ...extra] = argv;
  if (!['backup', 'check', 'restore'].includes(command) || !name || extra.length) {
    console.error('usage: node compress.mjs backup|check|restore <file>, from the project root');
    return 2;
  }
  try {
    const root = realpathSync(cwd);
    const file = target(root, resolve(cwd, name), name);
    if (command === 'backup') {
      console.log(`backup: ${backup(env, root, file)}`);
      return 0;
    }
    const from = newest(env, root, file);
    if (command === 'restore') {
      copyFileSync(from, file);
      console.log(`restored ${name} from ${from}`);
      return 0;
    }
    const before = readFileSync(from);
    const after = readFileSync(file);
    if (!after.toString('utf8').trim()) {
      console.log(`the rewrite of ${name} is empty; restore the backup`);
      return 1;
    }
    const all = spans(before.toString('utf8'));
    const missing = lost(before.toString('utf8'), after.toString('utf8'));
    for (const s of missing) console.log(`lost ${s.kind}: ${shown(s.text)}`);
    const pct = Math.round(Math.abs(100 - (after.length * 100) / before.length));
    const change = !before.length ? 'from empty' : after.length <= before.length ? `${pct}% smaller` : `${pct}% larger`;
    if (missing.length)
      console.log(
        `${missing.length} of ${all.length} protected spans lost; repair ${name} and check again, or restore the backup`,
      );
    else
      console.log(
        `ok: all ${all.length} protected spans kept; ${before.length} -> ${after.length} bytes (${change}); backup: ${from}`,
      );
    return missing.length ? 1 : 0;
  } catch (e) {
    console.error(`compress: ${e.message}`);
    return 2;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = main(process.argv.slice(2), process.env, process.cwd());
