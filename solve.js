// Fast drop-in for makefun-site 1.0.0 — written from scratch in this session.
//
// run(input) returns exactly the answer makefun-site 1.0.0's build(input)
// returns for the same input: the output tree as a JSON object of every path
// the build writes and that file's text, byte for byte. The rules are
// makefun-site's own (its README states them, its code is the reference
// wherever the two differ): its front matter, template dialect, Markdown
// subset, slug rule and report. Nothing here is copied from another
// generator; the pipeline below re-implements those rules, faster:
//
//  - one pass over each source's lines, shared by front matter and Markdown
//    (no split/join round trip);
//  - Markdown lexing and inline rendering with direct character checks
//    instead of a regular expression per line and a regex escape per
//    character; plain text runs are copied whole;
//  - slugify with an ASCII fast path (NFKD is the identity on ASCII) and a
//    per-build memo, since titles, tags and headings repeat;
//  - template rendering into an array joined once, with loop scopes reused
//    across iterations of one loop (rendering is synchronous, so no template
//    can keep a scope);
//  - each page's card computed once and reused by its layout.
//
// Nothing is cached from one run() call to the next: every memo lives
// inside one build.

const REPORT_FILE = 'build-report.txt';
const RESERVED = ['posts', 'tags', 'page'];

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const dirOf = (path) => {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
};

// ------------------------------------------------------------------ text

const ESC_ARR = [];
ESC_ARR[34] = '&quot;';
ESC_ARR[38] = '&amp;';
ESC_ARR[39] = '&#39;';
ESC_ARR[60] = '&lt;';
ESC_ARR[62] = '&gt;';
const ESC_RE = /[&<>"']/;

/** `text` with & < > " and ' escaped. */
function escapeHtml(text) {
  if (!ESC_RE.test(text)) return text;
  let out = '';
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const e = ESC_ARR[text.charCodeAt(i)];
    if (e !== undefined) {
      out += text.slice(start, i) + e;
      start = i + 1;
    }
  }
  return out + text.slice(start);
}

const SLUG_MAX = 64;

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run
 * of characters other than a-z and 0-9 one "-", none at either end, at most
 * 64 characters (a "-" left at the cut dropped), "untitled" when nothing is
 * left. `cache` is this build's memo.
 */
function slugify(text, cache) {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  let plain = text;
  // NFKD is the identity on ASCII, so only non-ASCII text needs it.
  if (/[^\x00-\x7F]/.test(text)) plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const c = plain.charCodeAt(i);
    let keep = -1;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === -1) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  if (out === '') out = 'untitled';
  cache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  const y = date.slice(0, 4);
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

// JavaScript's \s, as a test on one UTF-16 code unit.
const WS_ASCII = new Uint8Array(128);
for (const c of [9, 10, 11, 12, 13, 32]) WS_ASCII[c] = 1;
function isWS(code) {
  if (code < 128) return WS_ASCII[code] === 1;
  return (
    code === 0x85 ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

/** The words of `lines`: runs of characters other than whitespace. */
function wordsOfLines(lines) {
  let n = 0;
  for (let l = 0; l < lines.length; l++) {
    const line = lines[l];
    let inWord = false;
    for (let i = 0; i < line.length; i++) {
      const c = line.charCodeAt(i);
      const ws =
        c < 128
          ? WS_ASCII[c] === 1
          : c === 0x85 ||
            c === 0xa0 ||
            c === 0x1680 ||
            (c >= 0x2000 && c <= 0x200a) ||
            c === 0x2028 ||
            c === 0x2029 ||
            c === 0x202f ||
            c === 0x205f ||
            c === 0x3000 ||
            c === 0xfeff;
      if (ws) inWord = false;
      else if (!inWord) {
        inWord = true;
        n++;
      }
    }
  }
  return n;
}

// ------------------------------------------------------------ front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const LINE = /^([a-z_]+):(?: (.*))?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME = /^[a-z0-9-]+$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1)
          return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo))
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93)
        return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG.test(t)))
        return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

function isBlankFM(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/**
 * A source's front matter and body lines: { data, bodyLines }, or { error }
 * with the first reason it is refused. `lines` is the source's text split
 * on "\n" (line ends already made "\n").
 */
function parseFrontMatter(lines) {
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (isBlankFM(line) || line.charCodeAt(0) === 35) continue;
    const m = LINE.exec(line);
    if (!m) return { error: `line ${i + 1} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, bodyLines: lines.slice(close + 1) };
}

// ---------------------------------------------------------------- Markdown

function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return line.slice(a, b);
}

function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A fence-opening line's language, or null when the line is none. */
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (
      (c >= 65 && c <= 90) ||
      (c >= 97 && c <= 122) ||
      (c >= 48 && c <= 57) ||
      c === 95 ||
      c === 43 ||
      c === 45
    )
      i++;
    else break;
  }
  const lang = line.slice(3, i);
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
    i++;
  }
  return lang;
}

function fenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 35) n++;
  if (n === 0 || n > 6) return null;
  if (n >= line.length) return null;
  const c = line.charCodeAt(n);
  if (c !== 32 && c !== 9) return null;
  let s = n;
  while (s < line.length && (line.charCodeAt(s) === 32 || line.charCodeAt(s) === 9)) s++;
  if (s >= line.length) return null;
  let end = line.length;
  while (end > s && (line.charCodeAt(end - 1) === 32 || line.charCodeAt(end - 1) === 9)) end--;
  const text = line.slice(s, end);
  if (text === '') return null;
  return { depth: n, text };
}

function isHr(line) {
  const c0 = line.charCodeAt(0);
  if (c0 !== 45 && c0 !== 42) return false;
  if (line.charCodeAt(1) !== c0 || line.charCodeAt(2) !== c0) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  return isBlank(line) || fenceOpen(line) !== null || headingOf(line) !== null || isHr(line);
}

/** A bullet item's text, or null; an ordered item's number and text, or null. */
function listMarker(line) {
  const c0 = line.charCodeAt(0);
  if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) return { ordered: false, start: 1, text: line.slice(2) };
  if (c0 >= 48 && c0 <= 57) {
    let i = 0;
    while (i < line.length && line.charCodeAt(i) >= 48 && line.charCodeAt(i) <= 57) i++;
    if (i >= 1 && i <= 9 && line.charCodeAt(i) === 46 && line.charCodeAt(i + 1) === 32)
      return { ordered: true, start: Number(line.slice(0, i)), text: line.slice(i + 2) };
  }
  return null;
}

/** A continuation line (two or more spaces, then a non-space) or not. */
function isContinued(line) {
  if (line.charCodeAt(0) !== 32 || line.charCodeAt(1) !== 32) return false;
  let i = 2;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  return i < line.length && !isWS(line.charCodeAt(i));
}

/** `lines`' block tokens, in order. */
function lex(lines) {
  const tokens = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const lang = fenceOpen(line);
    if (lang !== null) {
      const body = [];
      i++;
      while (i < lines.length && !fenceClose(lines[i])) body.push(lines[i++]);
      i++;
      tokens.push({ type: 'code', lang, lines: body });
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      tokens.push({ type: 'heading', depth: heading.depth, text: heading.text });
      i++;
      continue;
    }
    if (isHr(line)) {
      tokens.push({ type: 'hr' });
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const body = [];
      while (i < lines.length && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
      }
      const kept = [];
      for (let k = 0; k < body.length; k++) {
        const t = trimLine(body[k]);
        if (t !== '') kept.push(t);
      }
      tokens.push({ type: 'blockquote', lines: kept });
      continue;
    }
    const marker = listMarker(line);
    if (marker !== null) {
      const isOrdered = marker.ordered;
      const items = [];
      while (i < lines.length) {
        const m = listMarker(lines[i]);
        if (m !== null && m.ordered === isOrdered) {
          items.push([trimLine(m.text)]);
          i++;
        } else if (isContinued(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      tokens.push({ type: 'list', ordered: isOrdered, start: marker.start, items: items.map((parts) => parts.join('\n')) });
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < lines.length && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    tokens.push({ type: 'paragraph', text: body.join('\n') });
  }
  return tokens;
}

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  const wlen = what.length;
  for (let j = from; j <= s.length - wlen; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

const WS_RE = /\s/;
const SPECIAL = /[\\`*[]/g;

/**
 * `s` rendered inline; `env.link(target)` is a link's href. Plain runs are
 * found by one regular-expression scan and copied whole; only the four
 * characters that open a construct are handled one by one. After every
 * construct the scan is re-aimed past it (a `**` with no closer is skipped
 * whole, as the char-by-char reading does), so a nested render cannot move
 * this scan.
 */
function inline(s, env) {
  let out = '';
  let run = 0;
  SPECIAL.lastIndex = 0;
  let m;
  while ((m = SPECIAL.exec(s)) !== null) {
    const i = m.index;
    const c = s.charCodeAt(i);
    if (c === 92 && i + 1 < s.length && ESCAPABLE.has(s[i + 1])) {
      if (i > run) out += escapeHtml(s.slice(run, i));
      out += escapeHtml(s[i + 1]);
      run = i + 2;
      SPECIAL.lastIndex = run;
      continue;
    }
    if (c === 96) {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        if (i > run) out += escapeHtml(s.slice(run, i));
        out += '<code>' + escapeHtml(s.slice(i + 1, j)) + '</code>';
        run = j + 1;
        SPECIAL.lastIndex = run;
        continue;
      }
    } else if (c === 42) {
      if (s.charCodeAt(i + 1) === 42) {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          if (i > run) out += escapeHtml(s.slice(run, i));
          out += '<strong>' + inline(s.slice(i + 2, j), env) + '</strong>';
          run = j + 2;
          SPECIAL.lastIndex = run;
          continue;
        }
        SPECIAL.lastIndex = i + 2;
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        if (i > run) out += escapeHtml(s.slice(run, i));
        out += '<em>' + inline(s.slice(i + 1, j), env) + '</em>';
        run = j + 1;
        SPECIAL.lastIndex = run;
        continue;
      }
    } else if (c === 91) {
      const k = findUnescaped(s, ']', i + 1);
      const mm = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
      const target = mm === -1 ? '' : s.slice(k + 2, mm);
      if (target !== '' && !WS_RE.test(target)) {
        if (i > run) out += escapeHtml(s.slice(run, i));
        out += '<a href="' + escapeHtml(env.link(target)) + '">' + inline(s.slice(i + 1, k), env) + '</a>';
        run = mm + 1;
        SPECIAL.lastIndex = run;
        continue;
      }
    }
    SPECIAL.lastIndex = i + 1;
  }
  if (s.length > run) out += escapeHtml(s.slice(run));
  return out;
}

/**
 * `lines` rendered: its HTML (each block on its own lines, a "\n" after the
 * last), its table of contents (every level 2 and 3 heading: level, id and
 * its inline HTML) and its excerpt (the first paragraph's inline HTML, or "").
 */
function renderMarkdown(lines, env, slugCache) {
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  for (const t of lex(lines)) {
    switch (t.type) {
      case 'heading': {
        const id = uniqueSlug(slugify(t.text, slugCache), ids);
        const html = inline(t.text, env);
        blocks.push(`<h${t.depth} id="${id}">${html}</h${t.depth}>`);
        if (t.depth === 2 || t.depth === 3) toc.push({ level: t.depth, id, html });
        break;
      }
      case 'code': {
        const cls = t.lang === '' ? '' : ` class="language-${escapeHtml(t.lang)}"`;
        let inner = '';
        for (let k = 0; k < t.lines.length; k++) inner += escapeHtml(t.lines[k]) + '\n';
        blocks.push(`<pre><code${cls}>${inner}</code></pre>`);
        break;
      }
      case 'hr':
        blocks.push('<hr>');
        break;
      case 'blockquote':
        blocks.push(
          t.lines.length === 0
            ? '<blockquote>\n</blockquote>'
            : `<blockquote>\n<p>${inline(t.lines.join('\n'), env)}</p>\n</blockquote>`,
        );
        break;
      case 'list': {
        const tag = t.ordered ? 'ol' : 'ul';
        const open = t.ordered && t.start !== 1 ? `<ol start="${t.start}">` : `<${tag}>`;
        let inner = '';
        for (let k = 0; k < t.items.length; k++) inner += `<li>${inline(t.items[k], env)}</li>\n`;
        blocks.push(`${open}\n${inner}</${tag}>`);
        break;
      }
      case 'paragraph': {
        const html = inline(t.text, env);
        if (excerpt === null) excerpt = html;
        blocks.push(`<p>${html}</p>`);
        break;
      }
    }
  }
  return { html: blocks.map((b) => `${b}\n`).join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

const INCLUDE_DEPTH = 8;

const PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF = /^if (not )?(\S+)$/;
const INCLUDE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

function pathOf(name, text) {
  if (!PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if'))
          throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  const first = path[0];
  while (s !== null && !Object.hasOwn(s.vars, first)) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[first];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * `nodes` rendered into `out` in `scope` ({ vars, parent }). `ctx` holds the
 * parsed templates, the HTML escape and the include depth.
 */
function renderNodes(nodes, scope, ctx, depth, out) {
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        out.push(ctx.escape(textOf(lookup(scope, n.path))));
        break;
      case 'raw':
        out.push(textOf(lookup(scope, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        // One scope for the whole loop; its element and loop record are
        // re-bound each iteration. Rendering is synchronous, so no template
        // can keep a scope from an earlier iteration.
        const vars = {};
        const loop = { index: 0, first: false, last: false, length: xs.length };
        const child = { vars, parent: scope };
        for (let k = 0; k < xs.length; k++) {
          vars[n.name] = xs[k];
          vars.loop = loop;
          loop.index = k + 1;
          loop.first = k === 0;
          loop.last = k === xs.length - 1;
          renderNodes(n.body, child, ctx, depth, out);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) {
          if (t.fn !== null) t.fn(ctx.escape, textOf, truthy, renderNodes, out, scope, ctx, depth + 1);
          else renderNodes(t.nodes, scope, ctx, depth + 1, out);
        }
        break;
      }
    }
  }
}

// ------------------------------------------------------- template compiler
//
// A parsed template compiled to one straight-line function, so rendering a
// page does not walk a node tree through a switch per node. The generated
// code inlines the scope lookup (first name from the nearest scope holding
// it, then own properties) and the string fast path of textOf; it calls the
// module's escapeHtml, textOf, truthy and renderNodes, passed in as
// parameters. If compiling fails, the caller keeps the node tree and renders
// it with renderNodes instead, so the answer is the same either way.

function compileTemplate(nodes) {
  let code = '';
  let uid = 0;

  // Statements that resolve `path` from `scopeVar` into a fresh temp, and
  // the temp's name. Exactly lookup()'s semantics, inlined.
  function lookupCode(path, scopeVar) {
    const v = `_v${uid++}`;
    const s = `_s${uid++}`;
    code += `let ${v};{let ${s}=${scopeVar};while(${s}!==null&&!Object.hasOwn(${s}.vars,${JSON.stringify(path[0])}))${s}=${s}.parent;${v}=${s}===null?undefined:${s}.vars[${JSON.stringify(path[0])}];}`;
    for (let k = 1; k < path.length; k++) {
      const seg = JSON.stringify(path[k]);
      code += `if(${v}===null||typeof ${v}!=="object"||!Object.hasOwn(${v},${seg}))${v}=undefined;else ${v}=${v}[${seg}];`;
    }
    return v;
  }

  function gen(ns, scopeVar, depth) {
    for (const n of ns) {
      if (n.kind === 'text') {
        code += `out.push(${JSON.stringify(n.text)});`;
      } else if (n.kind === 'var') {
        const v = lookupCode(n.path, scopeVar);
        code += `out.push(E(typeof ${v}==="string"?${v}:T(${v})));`;
      } else if (n.kind === 'raw') {
        const v = lookupCode(n.path, scopeVar);
        code += `out.push(typeof ${v}==="string"?${v}:T(${v}));`;
      } else if (n.kind === 'if') {
        const v = lookupCode(n.path, scopeVar);
        code += `if(TR(${v})!==${n.not}){`;
        gen(n.then, scopeVar, depth);
        code += '}';
        if (n.else !== null) {
          code += 'else{';
          gen(n.else, scopeVar, depth);
          code += '}';
        }
      } else if (n.kind === 'for') {
        const xs = lookupCode(n.path, scopeVar);
        const vars = `_vars${uid++}`;
        const loop = `_loop${uid++}`;
        const child = `_sc${uid++}`;
        const k = `_k${uid++}`;
        const name = JSON.stringify(n.name);
        code += `{if(Array.isArray(${xs})){const ${vars}={};const ${loop}={index:0,first:false,last:false,length:${xs}.length};const ${child}={vars:${vars},parent:${scopeVar}};for(let ${k}=0;${k}<${xs}.length;${k}++){${vars}[${name}]=${xs}[${k}];${vars}.loop=${loop};${loop}.index=${k}+1;${loop}.first=${k}===0;${loop}.last=${k}===${xs}.length-1;`;
        gen(n.body, child, depth);
        code += '}}}';
      } else if (n.kind === 'include') {
        const e = `_e${uid++}`;
        code += `{const ${e}=ctx.templates.get(${JSON.stringify(n.name)});if(${e}!==undefined&&depth<8){if(${e}.fn!==null)${e}.fn(E,T,TR,RN,out,${scopeVar},ctx,depth+1);else RN(${e}.nodes,${scopeVar},ctx,depth+1,out);}}`;
      }
    }
  }

  gen(nodes, 'scope', 0);
  // (E, T, TR, RN, out, scope, ctx, depth)
  return new Function('E', 'T', 'TR', 'RN', 'out', 'scope', 'ctx', 'depth', code);
}

// ---------------------------------------------------------------- the build

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** A page's link record as templates read it. */
const linkOf = (s) =>
  s === null
    ? null
    : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };

/** One site's output tree: path -> text. */
export function run(input) {
  const slugCache = new Map();
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      const nodes = parseTemplate(name, input.templates[name]);
      let fn = null;
      try {
        fn = compileTemplate(nodes);
      } catch {
        fn = null;
      }
      templates.set(name, { nodes, fn });
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }

  const b = {
    input,
    base: input.site.base_url.replace(/\/+$/, ''),
    templates,
    sources: [],
    statics: [],
    bySource: new Map(),
    broken: new Set(),
    report,
    posts: [],
    tags: [],
    output: {},
  };

  // 1. Sources, in code-unit order of their paths; a source that is not
  // .md is static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (let fi = 0; fi < files.length; fi++) {
    const f = files[fi];
    if (f.path.endsWith('.md')) b.sources.push({ path: f.path, lines: f.content.replace(/\r\n?/g, '\n').split('\n') });
    else b.statics.push({ path: f.path, content: f.content });
  }

  // 2. Front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (let si = 0; si < b.sources.length; si++) {
    const s = b.sources[si];
    const fm = parseFrontMatter(s.lines);
    if ('error' in fm) {
      b.report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.bodyLines = fm.bodyLines;
    s.post = s.path.startsWith('posts/');
    let own;
    for (let d = 1; d < RESERVED.length; d++) {
      if (s.path.startsWith(`${RESERVED[d]}/`)) {
        own = RESERVED[d];
        break;
      }
    }
    if (own !== undefined) {
      b.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      b.report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!b.templates.has(layout)) {
      b.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      b.report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  b.sources = kept;

  // 3. Permalinks: each page's output directory and url.
  const taken = new Map();
  const takenIn = (dir) => {
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    return set;
  };
  for (let si = 0; si < b.sources.length; si++) {
    const s = b.sources[si];
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, slugCache), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${b.base}/${s.outDir}/`;
    b.bySource.set(s.path, s);
  }

  // 4. Markdown, each body's links resolved.
  const staticPaths = new Set(b.statics.map((f) => f.path));
  const resolved = new Map();
  const resolveCached = (dir, rel) => {
    const key = `${dir}\n${rel}`;
    const hit = resolved.get(key);
    if (hit !== undefined) return hit;
    const path = resolvePath(dir, rel);
    resolved.set(key, path);
    return path;
  };
  for (let si = 0; si < b.sources.length; si++) {
    const s = b.sources[si];
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolveCached(dir, rel);
        if (path !== null && b.bySource.has(path)) return `${b.bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${b.base}/${path}${frag}`;
        b.broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.bodyLines, env, slugCache);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. Collections: posts newest first, then by slug; newer/older neighbours.
  const posts = b.sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  b.posts = posts;
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. Tags, grouped by slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    const names = s.data.tags ?? [];
    for (let k = 0; k < names.length; k++) {
      const slug = slugify(names[k], slugCache);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(names[k]);
      }
    }
    return out;
  };
  for (let pi = 0; pi < b.posts.length; pi++) {
    const p = b.posts[pi];
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name, slugCache);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${b.base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (let si = 0; si < b.sources.length; si++) {
    const s = b.sources[si];
    if (!s.post)
      s.tagRefs = ownTags(s).map((name) => bySlug.get(slugify(name, slugCache)) ?? { name, slug: slugify(name, slugCache), url: '', posts: [] });
  }
  b.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Each source's card, computed once and reused by its layout.
  for (let si = 0; si < b.sources.length; si++) {
    const s = b.sources[si];
    s.card = {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(wordsOfLines(s.bodyLines) / 200)),
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
  }

  // 7. Layouts: pages, index pages, tag pages, statics.
  const site = { title: input.site.title, base_url: b.base };
  const allTags = b.tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = b.posts.slice(0, input.site.recent).map((p) => p.card);
  const ctx = { templates: b.templates, escape: escapeHtml };
  const render = (name, vars) => {
    const entry = b.templates.get(name);
    if (entry === undefined) return null;
    const out = [];
    const scope = { vars: { site, tags: allTags, recent, ...vars }, parent: null };
    if (entry.fn !== null) entry.fn(escapeHtml, textOf, truthy, renderNodes, out, scope, ctx, 0);
    else renderNodes(entry.nodes, scope, ctx, 0, out);
    return out.join('');
  };
  for (let si = 0; si < b.sources.length; si++) {
    const s = b.sources[si];
    const page = {
      ...s.card,
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
    b.output[`${s.outDir}/index.html`] = render(s.layout, { page });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(b.posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${b.base}/` : `${b.base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: b.posts.slice((k - 1) * per, k * per).map((p) => p.card),
      pager: {
        number: k,
        total: pages,
        url: indexUrl(k),
        newer_url: k === 1 ? '' : indexUrl(k - 1),
        older_url: k === pages ? '' : indexUrl(k + 1),
      },
    });
    if (html !== null) b.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (let ti = 0; ti < b.tags.length; ti++) {
    const t = b.tags[ti];
    const html = render('tag', {
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => p.card) },
    });
    if (html !== null) b.output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) b.output['tags/index.html'] = tagsHtml;
  for (let fi = 0; fi < b.statics.length; fi++) {
    const f = b.statics[fi];
    if (Object.hasOwn(b.output, f.path)) b.report.push(`shadowed ${f.path}: a built page has its path`);
    else b.output[f.path] = f.content;
  }

  // 8. The report.
  const lines = [...b.report, ...b.broken].sort(byCodeUnits);
  const pageCount = b.sources.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${b.posts.length} posts, ${b.tags.length} tags and ${b.statics.length} static files`);
  b.output[REPORT_FILE] = `${lines.join('\n')}\n`;

  return b.output;
}
