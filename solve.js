// Fleet — a faster drop-in for makefun-site 1.0.0.
//
// run(input) returns, for every input { site, templates, files }, exactly the
// output tree makefun-site 1.0.0's build returns: every page's index.html, the
// index and tag pages, build-report.txt and each static file, byte for byte.
//
// makefun-site's dialect is its own (front matter, template language, Markdown
// subset, slug rule, report), so this module reimplements those semantics
// exactly, with the hot paths rewritten for speed: the Markdown lexer uses
// direct character checks instead of a regex per line, lexing and rendering
// run in one pass with no token objects, the inline renderer writes plain
// runs as whole segments, slugify / long dates / link resolutions are
// memoised per run, one card is computed per page and shared by every use,
// and front matter parsing slices only the lines up to the closing ---.
//
// Every cache lives in one run() call and is thrown away with it: each case
// is answered alone, with no clock, no randomness, no I/O and no cross-case
// state, so two runs over the same input are byte-identical.
//
// Node 22 standard library only. No dependencies, no WebAssembly, no native
// addons, no network.

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ------------------------------------------------------------------ text --

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const HAS_ESCAPABLE = /[&<>"']/;
const ESCAPABLE_RE = /[&<>"']/g;

/** `text` with & < > " and ' escaped. */
function escapeHtml(text) {
  return HAS_ESCAPABLE.test(text) ? text.replace(ESCAPABLE_RE, (c) => ESCAPES[c]) : text;
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const COMBINING = /\p{M}/gu;

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run
 * of characters other than a-z and 0-9 one "-", none at either end, at most
 * 64 characters (a "-" left at the cut dropped), and "untitled" when nothing
 * is left. Pure ASCII text skips normalisation: NFKD is the identity on it
 * and it holds no combining marks.
 */
function slugifyPlain(text) {
  let plain = text;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) {
      plain = text.normalize('NFKD').replace(COMBINING, '');
      break;
    }
  }
  let out = '';
  let pendingGap = false;
  for (let i = 0; i < plain.length; i++) {
    const ch = plain[i];
    let keep = '';
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === '') {
      if (out.length > 0) pendingGap = true;
      continue;
    }
    if (pendingGap) {
      out += '-';
      pendingGap = false;
    }
    out += keep;
  }
  if (out.length > 64) {
    out = out.slice(0, 64);
    let end = out.length;
    while (end > 0 && out[end - 1] === '-') end--;
    out = out.slice(0, end);
  }
  return out === '' ? 'untitled' : out;
}

/** `slugify` memoised per run: titles, tag names and headings repeat a lot. */
function slugify(text, run) {
  const hit = run.slugs.get(text);
  if (hit !== undefined) return hit;
  const v = slugifyPlain(text);
  run.slugs.set(text, v);
  return v;
}

/** `slug` made unique against `taken` (and added to it): slug, slug-2, ... */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone, memoised per run. */
function longDate(date, run) {
  const hit = run.dates.get(date);
  if (hit !== undefined) return hit;
  const v = `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
  run.dates.set(date, v);
  return v;
}

// ------------------------------------------------------------ front matter --

const KNOWN_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const LAYOUT_PATTERN = /^[a-z0-9-]+$/;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_PATTERN = /^[^"[\]]+$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysInMonth(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function readString(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) {
      return { error: 'a quoted string is not closed' };
    }
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) {
          return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        }
        out += n;
        i++;
      } else if (c === '"') {
        return { error: 'a quoted string holds a stray quote' };
      } else {
        out += c;
      }
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function readValue(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = readString(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE_PATTERN.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) {
        return { error: 'key "tags": not a list [a, b]' };
      }
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG_PATTERN.test(t))) {
        return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return LAYOUT_PATTERN.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG_PATTERN.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** Whether `line` is blank (spaces and tabs only). */
function blank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

/** Whether `ch` (a char code) is a lower-case letter or underscore. */
function isKeyChar(code) {
  return (code >= 97 && code <= 122) || code === 95;
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. `text` has "\n" line ends. Only the lines up
 * to the closing --- are ever split; the body is one slice of the source.
 */
function parseFrontMatter(text) {
  if (text.length < 3 || text[0] !== '-' || text[1] !== '-' || text[2] !== '-') {
    return { error: 'no front matter' };
  }
  if (text.length > 3 && text[3] !== '\n') return { error: 'no front matter' };
  // Find the closing --- line: a "\n---" followed by "\n" or end of text.
  let closeAt = -1;
  let scan = 3;
  for (;;) {
    const at = text.indexOf('\n---', scan);
    if (at === -1) break;
    const after = at + 4;
    if (after === text.length || text[after] === '\n') {
      closeAt = at;
      break;
    }
    scan = at + 1;
  }
  if (closeAt === -1) return { error: 'the front matter is not closed' };
  const head = text.slice(4, closeAt);
  const fmLines = head === '' ? [] : head.split('\n');
  const data = {};
  for (let j = 0; j < fmLines.length; j++) {
    const line = fmLines[j];
    if (blank(line) || line.charCodeAt(0) === 35) continue;
    const colon = line.indexOf(':');
    if (colon <= 0) return { error: `line ${j + 2} is not "key: value"` };
    for (let k = 0; k < colon; k++) {
      if (!isKeyChar(line.charCodeAt(k))) return { error: `line ${j + 2} is not "key: value"` };
    }
    let raw;
    if (colon === line.length - 1) raw = '';
    else if (line[colon + 1] === ' ') raw = line.slice(colon + 2);
    else return { error: `line ${j + 2} is not "key: value"` };
    let end = raw.length;
    while (end > 0 && (raw[end - 1] === ' ' || raw[end - 1] === '\t')) end--;
    if (end !== raw.length) raw = raw.slice(0, end);
    const key = line.slice(0, colon);
    if (!KNOWN_KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = readValue(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  const bodyAt = closeAt + 4;
  const body = bodyAt === text.length ? '' : text.slice(bodyAt + 1);
  return { data, body };
}

// --------------------------------------------------------------- markdown --

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const HAS_WS = /\s/;
const CONTINUED_LINE = /^ {2,}\S/;

/** A paragraph line as it is rendered: spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line[a] === ' ' || line[a] === '\t')) a++;
  while (b > a && (line[b - 1] === ' ' || line[b - 1] === '\t')) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** A fence's language, or null when `line` does not open one. */
function fenceLang(line) {
  if (line[0] !== '`' || line[1] !== '`' || line[2] !== '`') return null;
  let j = 3;
  while (j < line.length) {
    const c = line.charCodeAt(j);
    const ok =
      (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) ||
      c === 95 || c === 43 || c === 45;
    if (!ok) break;
    j++;
  }
  const lang = line.slice(3, j);
  while (j < line.length && (line[j] === ' ' || line[j] === '\t')) j++;
  return j === line.length ? lang : null;
}

/** Whether `line` closes a fence. */
function fenceCloses(line) {
  if (line[0] !== '`' || line[1] !== '`' || line[2] !== '`') return false;
  for (let j = 3; j < line.length; j++) {
    if (line[j] !== ' ' && line[j] !== '\t') return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let n = 0;
  while (n < line.length && line[n] === '#') n++;
  if (n === 0 || n > 6) return null;
  const after = line[n];
  if (after !== ' ' && after !== '\t') return null;
  let j = n;
  while (j < line.length && (line[j] === ' ' || line[j] === '\t')) j++;
  let e = line.length;
  while (e > j && (line[e - 1] === ' ' || line[e - 1] === '\t')) e--;
  if (e === j) return null;
  return { depth: n, text: line.slice(j, e) };
}

/** Whether `line` is a thematic break. */
function isBreak(line) {
  const c0 = line[0];
  if (c0 !== '-' && c0 !== '*') return false;
  if (line[1] !== c0 || line[2] !== c0) return false;
  for (let j = 3; j < line.length; j++) {
    if (line[j] !== ' ' && line[j] !== '\t') return false;
  }
  return true;
}

/** A bullet list item's text, or null when `line` does not open one. */
function bulletText(line) {
  if ((line[0] === '-' || line[0] === '*') && line[1] === ' ') return line.slice(2);
  return null;
}

/** An ordered list item's number and text, or null. */
function orderedItem(line) {
  let j = 0;
  while (j < line.length) {
    const c = line.charCodeAt(j);
    if (c < 48 || c > 57) break;
    j++;
  }
  if (j === 0 || j > 9) return null;
  if (line[j] !== '.' || line[j + 1] !== ' ') return null;
  return { num: Number(line.slice(0, j)), text: line.slice(j + 2) };
}

/** Whether `line` ends a paragraph: blank, a fence, a heading or a break. */
function endsPara(line) {
  return blank(line) || fenceLang(line) !== null || headingOf(line) !== null || isBreak(line);
}

/** The first index from `from` where `s` holds `what` outside an escape, or -1. */
function findUnescaped(s, what, from) {
  const wlen = what.length;
  const last = s.length - wlen;
  for (let j = from; j <= last; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
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
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s[j] !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/**
 * `s` rendered inline; `link(target)` is a link's href. Plain runs are
 * written as whole segments — a segment holds no escapable character by
 * construction, so no per-character escaping ever happens.
 */
function inline(s, link) {
  const out = [];
  const n = s.length;
  let i = 0;
  let seg = 0;
  while (i < n) {
    const c = s[i];
    if (c === '\\' && i + 1 < n && ESCAPABLE.has(s[i + 1])) {
      if (seg < i) out.push(s.slice(seg, i));
      const e = s[i + 1];
      out.push(e === '>' ? '&gt;' : e);
      i += 2;
      seg = i;
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        if (seg < i) out.push(s.slice(seg, i));
        out.push('<code>', escapeHtml(s.slice(i + 1, j)), '</code>');
        i = j + 1;
        seg = i;
      } else {
        i++;
      }
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          if (seg < i) out.push(s.slice(seg, i));
          out.push('<strong>', inline(s.slice(i + 2, j), link), '</strong>');
          i = j + 2;
          seg = i;
        } else {
          i += 2;
        }
      } else {
        const j = findSingleStar(s, i + 1);
        if (j > i + 1) {
          if (seg < i) out.push(s.slice(seg, i));
          out.push('<em>', inline(s.slice(i + 1, j), link), '</em>');
          i = j + 1;
          seg = i;
        } else {
          i++;
        }
      }
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', i + 1);
      const m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !HAS_WS.test(target)) {
        if (seg < i) out.push(s.slice(seg, i));
        out.push('<a href="', escapeHtml(link(target)), '">', inline(s.slice(i + 1, k), link), '</a>');
        i = m + 1;
        seg = i;
      } else {
        i++;
      }
      continue;
    }
    if (c === '&' || c === '<' || c === '>' || c === '"' || c === "'") {
      if (seg < i) out.push(s.slice(seg, i));
      out.push(ESCAPES[c]);
      i++;
      seg = i;
      continue;
    }
    i++;
  }
  if (seg < n) out.push(s.slice(seg, n));
  return out.join('');
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the
 * last), its table of contents (every level 2 and 3 heading: level, id and
 * its inline HTML) and its excerpt (the first paragraph's inline HTML, or
 * ""). Lexing and rendering run in one pass, with no token objects.
 */
function renderMarkdown(src, link, run) {
  const lines = src.split('\n');
  const total = lines.length;
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  while (i < total) {
    const line = lines[i];
    if (blank(line)) {
      i++;
      continue;
    }
    const lang = fenceLang(line);
    if (lang !== null) {
      const body = [];
      i++;
      while (i < total && !fenceCloses(lines[i])) body.push(lines[i++]);
      i++;
      const parts = [];
      for (let k = 0; k < body.length; k++) {
        parts.push(escapeHtml(body[k]));
        parts.push('\n');
      }
      blocks.push(`<pre><code${lang === '' ? '' : ` class="language-${lang}"`}>${parts.join('')}</code></pre>`);
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text, run), ids);
      const html = inline(heading.text, link);
      blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (isBreak(line)) {
      blocks.push('<hr>');
      i++;
      continue;
    }
    if (line[0] === '>') {
      const body = [];
      while (i < total && lines[i][0] === '>') {
        let l = lines[i++];
        l = l.slice(1);
        if (l[0] === ' ') l = l.slice(1);
        body.push(trimLine(l));
      }
      const kept = body.filter((l) => l !== '');
      blocks.push(
        kept.length === 0
          ? '<blockquote>\n</blockquote>'
          : `<blockquote>\n<p>${inline(kept.join('\n'), link)}</p>\n</blockquote>`,
      );
      continue;
    }
    const bullet = bulletText(line);
    const ordered = bullet === null ? orderedItem(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const items = [];
      while (i < total) {
        if (isOrdered) {
          const m = orderedItem(lines[i]);
          if (m !== null) {
            items.push([trimLine(m.text)]);
            i++;
            continue;
          }
        } else {
          const m = bulletText(lines[i]);
          if (m !== null) {
            items.push([trimLine(m)]);
            i++;
            continue;
          }
        }
        if (CONTINUED_LINE.test(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      const start = isOrdered ? ordered.num : 1;
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      const parts = [];
      for (let k = 0; k < items.length; k++) {
        parts.push(`<li>${inline(items[k].join('\n'), link)}</li>\n`);
      }
      blocks.push(`${open}\n${parts.join('')}</${tag}>`);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < total && !endsPara(lines[i])) body.push(trimLine(lines[i++]));
    const html = inline(body.join('\n'), link);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.length === 0 ? '' : `${blocks.join('\n')}\n`, toc, excerpt: excerpt ?? '' };
}

// --------------------------------------------------------------- templates --

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_PATTERN = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_PATTERN = /^if (not )?(\S+)$/;
const INCLUDE_PATTERN = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_PATTERN.test(text)) {
    throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  }
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === n - 1) {
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
      if (close === -1) {
        throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      }
      if (text !== '') {
        tokens.push({ t: 'text', text });
        text = '';
      }
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? n : nl;
    const standalone = blank(src.slice(lineStart, open)) && blank(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') {
      tokens.push({ t: 'text', text });
      text = '';
    }
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? n : nl + 1) : end;
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
    if (tok.t === 'text') {
      body.push({ kind: 'text', text: tok.text });
    } else if (tok.t === 'var' || tok.t === 'raw') {
      body.push({ kind: tok.t, path: tok.path });
    } else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_PATTERN.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_PATTERN.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) {
          throw new TemplateError(`template "${name}": an else outside an if`);
        }
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        const want = tag === 'endfor' ? 'for' : 'if';
        if (top.kind !== want) {
          throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        }
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_PATTERN.exec(tag)) !== null) {
        body.push({ kind: 'include', name: m[1] });
      } else {
        throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
      }
    }
  }
  if (stack.length > 1) {
    throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  }
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
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

/** `nodes` rendered in `scope` ({ vars, parent }), appended to `out`. */
function renderNodes(nodes, scope, run, depth, out) {
  for (let ni = 0; ni < nodes.length; ni++) {
    const nd = nodes[ni];
    switch (nd.kind) {
      case 'text':
        out.push(nd.text);
        break;
      case 'var':
        out.push(escapeHtml(textOf(lookup(scope, nd.path))));
        break;
      case 'raw':
        out.push(textOf(lookup(scope, nd.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scope, nd.path));
        const branch = v !== nd.not ? nd.then : nd.else;
        if (branch !== null) renderNodes(branch, scope, run, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, nd.path);
        if (!Array.isArray(xs)) break;
        // One scope object per loop, reused across iterations: rendering is
        // synchronous, so no iteration can observe a later one's bindings.
        const loop = { index: 1, first: true, last: xs.length === 1, length: xs.length };
        const vars = { loop };
        vars[nd.name] = xs[0];
        const child = { vars, parent: scope };
        for (let k = 0; k < xs.length; k++) {
          vars[nd.name] = xs[k];
          loop.index = k + 1;
          loop.first = k === 0;
          loop.last = k === xs.length - 1;
          renderNodes(nd.body, child, run, depth, out);
        }
        break;
      }
      case 'include': {
        const t = run.templates.get(nd.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, scope, run, depth + 1, out);
        break;
      }
    }
  }
}

// ------------------------------------------------------------------- build --

/** The top-level directories the generator writes itself. */
const RESERVED = ['posts', 'tags', 'page'];

/** The words of a body: its runs of characters other than whitespace. Counted
 * by hand: the whitespace set below is exactly JavaScript's \s (WhiteSpace
 * plus LineTerminator), so the count matches String.match(/\S+/g) on every
 * input, without building a match array. */
function wordsOf(text) {
  let count = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const ws =
      c === 32 ||
      (c >= 9 && c <= 13) ||
      c === 0xA0 ||
      c === 0x1680 ||
      (c >= 0x2000 && c <= 0x200A) ||
      c === 0x2028 ||
      c === 0x2029 ||
      c === 0x202F ||
      c === 0x205F ||
      c === 0x3000 ||
      c === 0xFEFF;
    if (ws) inWord = false;
    else if (!inWord) {
      inWord = true;
      count++;
    }
  }
  return count;
}

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(seg);
    }
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** Whether `target` holds a scheme (`https:`, `mailto:` ...). */
function hasScheme(target) {
  const c0 = target.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < target.length; i++) {
    const c = target.charCodeAt(i);
    if (c === 58) return true;
    if (
      !((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 43 || c === 45 || c === 46)
    ) {
      return false;
    }
  }
  return false;
}

/**
 * A link target resolved from `dir`: a page's url, a static file's url, or
 * null when it names neither. Memoised per run in two levels (by directory,
 * then by target), so a repeated link costs one Map lookup with no key
 * string built; a broken link is still reported once per source that uses it.
 */
function resolveLink(run, dir, srcPath, target) {
  let byDir = run.links.get(dir);
  if (byDir === undefined) {
    byDir = new Map();
    run.links.set(dir, byDir);
  }
  let hit = byDir.get(target);
  if (hit === undefined) {
    hit = computeLink(run, dir, target);
    byDir.set(target, hit);
  }
  if (hit === null) {
    run.broken.add(`broken-link ${srcPath} -> ${target}`);
    return target;
  }
  return hit;
}

function computeLink(run, dir, target) {
  if (hasScheme(target) || target[0] === '/' || target[0] === '#') return target;
  const hash = target.indexOf('#');
  const rel = hash === -1 ? target : target.slice(0, hash);
  const frag = hash === -1 ? '' : target.slice(hash);
  const path = rel === '' ? null : resolvePath(dir, rel);
  if (path !== null) {
    const s = run.bySource.get(path);
    if (s !== undefined) return `${s.url}${frag}`;
    if (run.staticPaths.has(path)) return `${run.base}/${path}${frag}`;
  }
  return null;
}

/** A page's link record as templates read it. */
function linkOf(s, run) {
  if (s === null) return null;
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date, run),
  };
}

/** A post's card, as lists show it. Computed once per source, shared by every use. */
function cardOf(s, run) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date, run),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

/** A page as its layout reads it. */
function pageOf(s, run) {
  return {
    ...s.card,
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null, run),
    older: linkOf(s.older ?? null, run),
    is_post: s.post,
  };
}

/** One site's output tree: path -> text. */
export function run(input) {
  const run = {
    base: input.site.base_url.replace(/\/+$/, ''),
    templates: new Map(),
    slugs: new Map(),
    dates: new Map(),
    links: new Map(),
    bySource: new Map(),
    staticPaths: new Set(),
    broken: new Set(),
    report: [],
  };
  const output = {};

  // Templates, parsed in code-unit order of their name; one that does not
  // parse is reported and left out, as if it were not there.
  for (const name of Object.keys(input.templates).sort(cmp)) {
    try {
      run.templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      run.report.push(err.message);
    }
  }

  // Sources, in code-unit order of their paths, line ends made "\n".
  const files = [...input.files].sort((x, y) => cmp(x.path, y.path));
  let sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // Front matter: a refused source is reported and dropped, and so is a
  // draft. The checks run in order, and the first one that fails is the one
  // reported.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      run.report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      run.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      run.report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!run.templates.has(layout)) {
      run.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      run.report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  sources = kept;

  // Permalinks: each page's output directory and url, its slug unique in its
  // directory, in source order.
  const taken = new Map();
  const takenIn = (dir) => {
    if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
    return taken.get(dir);
  };
  for (const s of sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, run), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${run.base}/${s.outDir}/`;
    run.bySource.set(s.path, s);
  }

  // Markdown: each body's HTML, its links resolved.
  for (const f of statics) run.staticPaths.add(f.path);
  for (const s of sources) {
    const dir = dirOf(s.path);
    const link = (target) => resolveLink(run, dir, s.path, target);
    const md = renderMarkdown(s.body, link, run);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // Collections: the posts, newest date first, then by slug; newer/older.
  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => cmp(y.data.date, x.data.date) || cmp(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // Tags: grouped by their slug, each named as first met in the posts'
  // order, ordered by count of posts and then slug.
  const bySlug = new Map();
  const ownTagNames = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name, run);
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push(name);
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTagNames(p)) {
      const slug = slugify(name, run);
      if (!bySlug.has(slug)) {
        bySlug.set(slug, { name, slug, url: `${run.base}/tags/${slug}/`, posts: [] });
      }
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of sources) {
    if (!s.post) {
      s.tagRefs = ownTagNames(s).map(
        (name) => bySlug.get(slugify(name, run)) ?? { name, slug: slugify(name, run), url: '', posts: [] },
      );
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || cmp(x.slug, y.slug));

  // One card per source, shared by its layout, the index pages, the tag
  // pages and `recent`.
  for (const s of sources) s.card = cardOf(s, run);

  // Layouts: every page through its layout, the index pages and the tag pages.
  const site = { title: input.site.title, base_url: run.base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => p.card);
  const render = (name, vars) => {
    const nodes = run.templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, run, 0, out);
    return out.join('');
  };
  for (const s of sources) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s, run) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${run.base}/` : `${run.base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => p.card),
      pager: {
        number: k,
        total: pages,
        url: indexUrl(k),
        newer_url: k === 1 ? '' : indexUrl(k - 1),
        older_url: k === pages ? '' : indexUrl(k + 1),
      },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', {
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => p.card) },
    });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) run.report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report: every refusal, draft, broken link and template that did not
  // parse, sorted, then the counts.
  const lines = [...run.report, ...run.broken].sort(cmp);
  const pageCount = sources.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
