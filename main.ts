// mend: apply an AI model's edit, in one of four formats, to a tree of text files.
// Written from SPEC.md (version 1). Node 22, standard library only.
// Run as: node main.ts [--format=NAME] [--check] [--strict] [PATCH]
// The working directory is the root of the tree; PATCH is a path relative to it,
// or, when absent or `-`, the patch is read from standard input.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** An exit-2 fault: the whole run stops with one line on stdout. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit failed: reported as `error: <code> <path>`, the edit changes nothing. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';
const wsOnly = (s: string): boolean => s === '' || /^[ \t]+$/.test(s);
const leadingWS = (s: string): string => (s.match(/^[ \t]*/) ?? [''])[0];

/** A patch's lines: split at \n, one trailing \r removed from each, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A path is safe when it is not empty, does not start with /, holds no \, and none of its segments is empty, . or .. */
function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** Split a file's text into its lines, its line break, and whether it ends with one. */
function splitFile(text: string): { lines: string[]; br: string; ends: boolean } {
  if (text === '') return { lines: [], br: '\n', ends: false };
  const idx = text.indexOf('\n');
  const br = idx > 0 && text[idx - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  if (text.endsWith(br)) return { lines: parts.slice(0, -1), br, ends: true };
  return { lines: parts, br, ends: false };
}

/** Join lines back with the file's own break, and a final one exactly when it ended with one. */
function joinFile(lines: string[], br: string, ends: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (ends ? br : '');
}

/** The tree as the edits leave it. `now` holds the paths an edit changed (null: deleted); the rest is read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful moves, in the order they ran: [old, new]. */
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** The format of a patch, by the first of the rules in section 4 that holds, or null. */
function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** The key of a line at a matching tier: 0 exact, 1 trailing spaces/tabs removed, 2 both ends removed. */
function tierKey(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** The first tier at which O occurs in the file's lines at least once, with every occurrence's position, or null. */
function findMatch(O: string[], fileLines: string[], strict: boolean): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const want = O.map((s) => tierKey(s, tier));
    const positions: number[] = [];
    for (let i = 0; i + O.length <= fileLines.length; i++) {
      let ok = true;
      for (let j = 0; j < O.length; j++) {
        if (tierKey(fileLines[i + j]!, tier) !== want[j]) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** One line of a replacement: a context line (written as the file's own line at its O index) or a new line. */
interface NewLine {
  text: string;
  ctx: number | null;
}

/** Build the lines that replace a match: context lines come from the file, other lines are re-indented at tier 2. */
function buildReplacement(fileLines: string[], O: string[], N: NewLine[], tier: number, pos: number): string[] {
  const F = leadingWS(fileLines[pos] ?? '');
  const P = leadingWS(O[0] ?? '');
  return N.map((e) => {
    if (e.ctx !== null) return fileLines[pos + e.ctx]!;
    let line = e.text;
    if (tier === 2 && !wsOnly(line) && line.startsWith(P)) line = F + line.slice(P.length);
    return line;
  });
}

/* ---------------- unified diffs (section 6) ---------------- */

type HunkOp =
  | { kind: 'ctx'; text: string }
  | { kind: 'old'; text: string }
  | { kind: 'new'; text: string }
  | { kind: 'bs' };

interface Hunk {
  A: number;
  ops: HunkOp[];
  lastCtxOrPlusBackslash: boolean;
  lastPlusBackslash: boolean;
}

interface Section {
  headerOld: string | null | undefined;
  headerNew: string | null | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  diffOld: string | undefined;
  diffNew: string | undefined;
  isCreate: boolean;
  isDelete: boolean;
  hasHunk: boolean;
  hunks: Hunk[];
}

/** The path after `--- ` or `+++ `: up to the first tab, surrounding spaces removed, /dev/null is no file, a leading a/ or b/ removed. */
function headerPath(line: string): string | null {
  const t = line.slice(4).split('\t')[0]!.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) return t.slice(2);
  return t;
}

/** The first value that is not undefined. */
function pick<T>(...vs: Array<T | undefined>): T | undefined {
  for (const v of vs) if (v !== undefined) return v;
  return undefined;
}

/** Trim trailing empty context lines from a hunk body and work out its backslash flags. */
function finishHunk(h: Hunk): void {
  while (h.ops.length > 0) {
    const last = h.ops[h.ops.length - 1]!;
    if (last.kind === 'ctx' && last.text === '') h.ops.pop();
    else break;
  }
  let lastCtxOrPlus = -1;
  let lastPlus = -1;
  for (let j = 0; j < h.ops.length; j++) {
    if (h.ops[j]!.kind === 'ctx' || h.ops[j]!.kind === 'new') lastCtxOrPlus = j;
    if (h.ops[j]!.kind === 'new') lastPlus = j;
  }
  h.lastCtxOrPlusBackslash = lastCtxOrPlus >= 0 && h.ops[lastCtxOrPlus + 1]?.kind === 'bs';
  h.lastPlusBackslash = lastPlus >= 0 && h.ops[lastPlus + 1]?.kind === 'bs';
}

/** A hunk's old lines O and new lines N, in body order. */
function hunkON(h: Hunk): { O: string[]; N: NewLine[] } {
  const O: string[] = [];
  const N: NewLine[] = [];
  for (const op of h.ops) {
    if (op.kind === 'ctx') {
      const idx = O.length;
      O.push(op.text);
      N.push({ text: op.text, ctx: idx });
    } else if (op.kind === 'old') {
      O.push(op.text);
    } else if (op.kind === 'new') {
      N.push({ text: op.text, ctx: null });
    }
  }
  return { O, N };
}

/** Apply one hunk to a file's lines. Returns the new lines and whether the result ends with a line break. */
function applyHunk(fileLines: string[], ends: boolean, h: Hunk, d: number, strict: boolean, path: string): { lines: string[]; ends: boolean; dLen: number } {
  const { O, N } = hunkON(h);
  if (O.length === 0) {
    const at = Math.min(h.A + d, fileLines.length);
    const repl = N.map((e) => e.text);
    const lines = [...fileLines.slice(0, at), ...repl, ...fileLines.slice(at)];
    return { lines, ends: at === fileLines.length ? !h.lastCtxOrPlusBackslash : ends, dLen: N.length };
  }
  const found = findMatch(O, fileLines, strict);
  if (found === null) throw new Fail('no-match', path);
  const target = h.A - 1 + d;
  let best = found.positions[0]!;
  let bestDist = Math.abs(best - target);
  for (const p of found.positions) {
    const dist = Math.abs(p - target);
    if (dist < bestDist) {
      best = p;
      bestDist = dist;
    }
  }
  const pos = best;
  const repl = buildReplacement(fileLines, O, N, found.tier, pos);
  const lines = [...fileLines.slice(0, pos), ...repl, ...fileLines.slice(pos + O.length)];
  const endsNow = pos + O.length === fileLines.length ? !h.lastCtxOrPlusBackslash : ends;
  return { lines, ends: endsNow, dLen: N.length - O.length };
}

/** Read a patch's unified sections. Throws Exit2 on a parse fault. */
function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let curHunk: Hunk | null = null;
  let inBody = false;
  const newSection = (): Section => {
    const s: Section = {
      headerOld: undefined,
      headerNew: undefined,
      renameFrom: undefined,
      renameTo: undefined,
      diffOld: undefined,
      diffNew: undefined,
      isCreate: false,
      isDelete: false,
      hasHunk: false,
      hunks: [],
    };
    sections.push(s);
    return s;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const ln = i + 1;
    if (inBody) {
      if (line.startsWith('diff --git ') || (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '))) {
        finishHunk(curHunk!);
        inBody = false;
        curHunk = null;
        i--;
        continue;
      }
      if (line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line.startsWith('\\') || line === '') {
        if (line.startsWith(' ')) curHunk!.ops.push({ kind: 'ctx', text: line.slice(1) });
        else if (line.startsWith('-')) curHunk!.ops.push({ kind: 'old', text: line.slice(1) });
        else if (line.startsWith('+')) curHunk!.ops.push({ kind: 'new', text: line.slice(1) });
        else if (line.startsWith('\\')) curHunk!.ops.push({ kind: 'bs' });
        else curHunk!.ops.push({ kind: 'ctx', text: '' });
        continue;
      }
      finishHunk(curHunk!);
      inBody = false;
      curHunk = null;
      i--;
      continue;
    }
    if (line.startsWith('diff --git ')) {
      const m = line.slice('diff --git '.length).match(/^a\/([^ ]+) b\/([^ ]+)$/);
      if (m === null) throw new Exit2(`error: parse ${ln}`);
      cur = newSection();
      cur.diffOld = m[1];
      cur.diffNew = m[2];
      continue;
    }
    if (line.startsWith('--- ')) {
      const next = lines[i + 1];
      if (next !== undefined && next.startsWith('+++ ')) {
        if (cur !== null && !cur.hasHunk && cur.headerOld === undefined) {
          cur.headerOld = headerPath(line);
          cur.headerNew = headerPath(next);
        } else {
          cur = newSection();
          cur.headerOld = headerPath(line);
          cur.headerNew = headerPath(next);
        }
        i++;
        continue;
      }
      if (cur !== null && !cur.hasHunk) throw new Exit2(`error: parse ${ln + 1}`);
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${ln}`);
      const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (m === null) throw new Exit2(`error: parse ${ln}`);
      cur.hasHunk = true;
      curHunk = { A: parseInt(m[1]!, 10), ops: [], lastCtxOrPlusBackslash: false, lastPlusBackslash: false };
      cur.hunks.push(curHunk);
      inBody = true;
      continue;
    }
    if (cur !== null && !cur.hasHunk) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.isCreate = true;
      else if (line.startsWith('deleted file mode')) cur.isDelete = true;
    }
  }
  if (inBody && curHunk !== null) finishHunk(curHunk);
  return sections.map((sec) => unifiedSectionEdit(sec, strict));
}

/** One unified section as one edit. */
function unifiedSectionEdit(sec: Section, strict: boolean): Edit {
  return (tree) => {
    const oldPath = pick(sec.headerOld, sec.renameFrom, sec.diffOld);
    const newPath = pick(sec.headerNew, sec.renameTo, sec.diffNew);
    const isCreate = sec.isCreate || oldPath === null;
    const isDelete = sec.isDelete || newPath === null;
    if (isCreate) {
      const target = typeof newPath === 'string' ? newPath : '';
      if (!safe(target)) throw new Fail('unsafe', target);
      if (tree.get(target) !== null) throw new Fail('exists', target);
      const plusLines: string[] = [];
      let lastPlusBackslash = false;
      for (let hi = sec.hunks.length - 1; hi >= 0; hi--) {
        const h = sec.hunks[hi]!;
        if (h.ops.some((o) => o.kind === 'new')) {
          lastPlusBackslash = h.lastPlusBackslash;
          break;
        }
      }
      for (const h of sec.hunks) for (const op of h.ops) if (op.kind === 'new') plusLines.push(op.text);
      tree.now.set(target, plusLines.length === 0 ? '' : plusLines.join('\n') + (lastPlusBackslash ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const target = typeof oldPath === 'string' ? oldPath : '';
      if (!safe(target)) throw new Fail('unsafe', target);
      if (tree.get(target) === null) throw new Fail('missing', target);
      tree.now.set(target, null);
      return;
    }
    const oldP = typeof oldPath === 'string' ? oldPath : '';
    const newP = typeof newPath === 'string' ? newPath : '';
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    if (!safe(newP)) throw new Fail('unsafe', newP);
    const isMove = oldP !== newP;
    if (tree.get(oldP) === null) throw new Fail('missing', oldP);
    if (isMove && tree.get(newP) !== null) throw new Fail('exists', newP);
    const content = tree.get(oldP)!;
    const split = splitFile(content);
    let curLines = split.lines;
    let curEnds = split.ends;
    let d = 0;
    for (const h of sec.hunks) {
      const res = applyHunk(curLines, curEnds, h, d, strict, oldP);
      d += res.dLen;
      curLines = res.lines;
      curEnds = res.ends;
    }
    const out = joinFile(curLines, split.br, curEnds);
    if (isMove) {
      tree.now.set(newP, out);
      tree.now.set(oldP, null);
      tree.moves.push([oldP, newP]);
    } else {
      tree.now.set(oldP, out);
    }
  };
}

/* ---------------- SEARCH/REPLACE blocks (section 7) ---------------- */

/** Read a patch's SEARCH/REPLACE blocks. Throws Exit2 on a parse fault. */
function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let lastPath: string | undefined = undefined;
  let prevEnd = 0; // the line after the previous block's >>>>>>> REPLACE (0-based index)
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') continue;
    const searchLn = i + 1;
    // The path: the nearest line before SEARCH, after the previous block, not blank and not starting with ```.
    let path: string | undefined = undefined;
    for (let j = i - 1; j >= prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === undefined) path = lastPath;
    if (path === undefined) throw new Exit2(`error: parse ${searchLn}`);
    // Find ======= then >>>>>>> REPLACE after SEARCH (a new SEARCH first means the block is malformed).
    let sep = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
      if (lines[j]!.trimEnd() === '=======') {
        sep = j;
        break;
      }
    }
    if (sep < 0) throw new Exit2(`error: parse ${searchLn}`);
    let end = -1;
    for (let j = sep + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
    }
    if (end < 0) throw new Exit2(`error: parse ${searchLn}`);
    const oldLines = lines.slice(i + 1, sep);
    const newLines = lines.slice(sep + 1, end);
    const p = path;
    edits.push(searchReplaceEdit(p, oldLines, newLines, strict));
    lastPath = p;
    prevEnd = end + 1;
    i = end;
  }
  return edits;
}

/** One SEARCH/REPLACE block as one edit. */
function searchReplaceEdit(p: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (oldLines.length === 0) {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const split = splitFile(before);
    const found = findMatch(oldLines, split.lines, strict);
    if (found === null) throw new Fail('no-match', p);
    if (found.positions.length > 1) throw new Fail('ambiguous', p);
    const pos = found.positions[0]!;
    const N: NewLine[] = newLines.map((t) => ({ text: t, ctx: null }));
    const repl = buildReplacement(split.lines, oldLines, N, found.tier, pos);
    const out = [...split.lines.slice(0, pos), ...repl, ...split.lines.slice(pos + oldLines.length)];
    tree.now.set(p, joinFile(out, split.br, split.ends));
  };
}

/* ---------------- V4A patches (section 8) ---------------- */

type V4aSection =
  | { kind: 'add'; path: string; lines: string[] }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; moveTo: string | undefined; chunks: V4aChunk[] };

interface V4aChunk {
  anchor: string | null;
  ops: HunkOp[];
  eof: boolean;
  lastCtxOrPlusBackslash: boolean;
}

/** Read a V4A patch. Throws Exit2 on a parse fault. */
function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (!blank(lines[i]!)) {
    last = i;
    break;
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: V4aSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    const ln = i + 1;
    if (blank(line)) {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      const secLines: Array<{ plus: boolean; text: string }> = [];
      i++;
      while (i < last) {
        const l = lines[i]!;
        if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ') || l.trim() === '*** End Patch') break;
        if (l.startsWith('+')) secLines.push({ plus: true, text: l.slice(1) });
        else if (l === '') secLines.push({ plus: false, text: '' });
        else throw new Exit2(`error: parse ${i + 1}`);
        i++;
      }
      while (secLines.length > 0 && !secLines[secLines.length - 1]!.plus) secLines.pop();
      sections.push({ kind: 'add', path, lines: secLines.map((s) => s.text) });
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      sections.push({ kind: 'delete', path });
      i++;
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      const updateLn = ln;
      let moveTo: string | undefined = undefined;
      const chunks: V4aChunk[] = [];
      i++;
      let curChunk: V4aChunk | null = null;
      const closeChunk = (): void => {
        if (curChunk !== null) {
          const h: Hunk = { A: 0, ops: curChunk.ops, lastCtxOrPlusBackslash: false, lastPlusBackslash: false };
          finishHunk(h);
          curChunk.ops = h.ops;
          curChunk.lastCtxOrPlusBackslash = h.lastCtxOrPlusBackslash;
          chunks.push(curChunk);
          curChunk = null;
        }
      };
      let sawMove = false;
      while (i < last) {
        const l = lines[i]!;
        if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ') || l.trim() === '*** End Patch') break;
        if (l.startsWith('*** Move to: ') && !sawMove && curChunk === null && chunks.length === 0) {
          moveTo = l.slice('*** Move to: '.length).trim();
          sawMove = true;
          i++;
          continue;
        }
        if (l.startsWith('*** End of File')) {
          if (curChunk === null) throw new Exit2(`error: parse ${i + 1}`);
          curChunk.eof = true;
          closeChunk();
          i++;
          continue;
        }
        if (l.startsWith('@@')) {
          closeChunk();
          const anchorText = l.slice(2).trim();
          curChunk = { anchor: anchorText === '' ? null : anchorText, ops: [], eof: false, lastCtxOrPlusBackslash: false };
          i++;
          continue;
        }
        if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l === '') {
          if (curChunk === null) curChunk = { anchor: null, ops: [], eof: false, lastCtxOrPlusBackslash: false };
          if (l.startsWith(' ')) curChunk.ops.push({ kind: 'ctx', text: l.slice(1) });
          else if (l.startsWith('-')) curChunk.ops.push({ kind: 'old', text: l.slice(1) });
          else if (l.startsWith('+')) curChunk.ops.push({ kind: 'new', text: l.slice(1) });
          else curChunk.ops.push({ kind: 'ctx', text: '' });
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      closeChunk();
      if (chunks.length === 0 && moveTo === undefined) throw new Exit2(`error: parse ${updateLn}`);
      sections.push({ kind: 'update', path, moveTo, chunks });
      continue;
    }
    throw new Exit2(`error: parse ${ln}`);
  }
  return sections.map((sec) => v4aSectionEdit(sec, strict));
}

/** One V4A section as one edit. */
function v4aSectionEdit(sec: V4aSection, strict: boolean): Edit {
  if (sec.kind === 'add') {
    const p = sec.path;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, sec.lines.length === 0 ? '' : sec.lines.join('\n') + '\n');
    };
  }
  if (sec.kind === 'delete') {
    const p = sec.path;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
    };
  }
  const p = sec.path;
  const moveTo = sec.moveTo;
  const chunks = sec.chunks;
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (moveTo !== undefined && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (moveTo !== undefined && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const split = splitFile(before);
    let curLines = split.lines;
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const anchor = ch.anchor;
        let foundAt = -1;
        for (const tier of strict ? [0] : [0, 1, 2]) {
          for (let j = cursor; j < curLines.length; j++) {
            if (tierKey(curLines[j]!, tier) === tierKey(anchor, tier)) {
              foundAt = j;
              break;
            }
          }
          if (foundAt >= 0) break;
        }
        if (foundAt < 0) throw new Fail('no-match', p);
        cursor = foundAt + 1;
      }
      const { O, N } = hunkON({ A: 0, ops: ch.ops, lastCtxOrPlusBackslash: false, lastPlusBackslash: false });
      if (O.length === 0) {
        const at = ch.eof ? curLines.length : cursor;
        const repl = N.map((e) => e.text);
        curLines = [...curLines.slice(0, at), ...repl, ...curLines.slice(at)];
        cursor = at + repl.length;
        continue;
      }
      const found = findMatchFrom(O, curLines, cursor, strict, ch.eof);
      if (found === null) throw new Fail('no-match', p);
      const repl = buildReplacement(curLines, O, N, found.tier, found.pos);
      curLines = [...curLines.slice(0, found.pos), ...repl, ...curLines.slice(found.pos + O.length)];
      cursor = found.pos + repl.length;
    }
    const out = joinFile(curLines, split.br, split.ends);
    if (moveTo !== undefined) {
      tree.now.set(moveTo, out);
      tree.now.set(p, null);
      tree.moves.push([p, moveTo]);
    } else {
      tree.now.set(p, out);
    }
  };
}

/** The first tier with an occurrence of O at or after `from`; an end-of-file chunk takes only one ending at the last line. */
function findMatchFrom(O: string[], fileLines: string[], from: number, strict: boolean, eof: boolean): { tier: number; pos: number } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const want = O.map((s) => tierKey(s, tier));
    for (let i = from; i + O.length <= fileLines.length; i++) {
      let ok = true;
      for (let j = 0; j < O.length; j++) {
        if (tierKey(fileLines[i + j]!, tier) !== want[j]) {
          ok = false;
          break;
        }
      }
      if (ok) {
        if (eof && i + O.length !== fileLines.length) continue;
        return { tier, pos: i };
      }
    }
  }
  return null;
}

/* ---------------- JSON edits (section 9) ---------------- */

/** One JSON edit object, or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const need = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = need(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const norm = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = norm(before);
      const old = norm(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + norm(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = need(tree);
      const split = splitFile(before);
      if (line < 0 || line > split.lines.length) throw new Fail('no-match', p);
      const lines = [...split.lines];
      lines.splice(line, 0, ...add);
      tree.now.set(p, joinFile(lines, split.br, split.ends));
    };
  }
  return null;
}

/** Read a patch's JSON edits, in array form or JSON Lines form. Throws Exit2 on a parse fault. */
function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ---------------- the run (sections 1, 2, 10) ---------------- */

/** The output rows for a tree whose edits all succeeded: A/D/M lines, moves as R lines, in byte order of paths. */
function outputRows(tree: Tree): string[] {
  interface Row {
    sortKey: string;
    text: string;
    path: string;
    kind: string;
  }
  const rows: Row[] = [];
  const net = new Map<string, string>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const nowv = tree.now.get(p)!;
    if (was === nowv) continue;
    const kind = was === null ? 'A' : nowv === null ? 'D' : 'M';
    net.set(p, kind);
    rows.push({ sortKey: p, text: `${kind} ${p}`, path: p, kind });
  }
  for (const [oldP, newP] of tree.moves) {
    if (net.get(oldP) !== 'D' || net.get(newP) !== 'A') continue;
    const di = rows.findIndex((r) => r.kind === 'D' && r.path === oldP);
    const ai = rows.findIndex((r) => r.kind === 'A' && r.path === newP);
    if (di < 0 || ai < 0) continue;
    rows.splice(Math.max(di, ai), 1);
    rows.splice(Math.min(di, ai), 1);
    rows.push({ sortKey: newP, text: `R ${oldP} -> ${newP}`, path: newP, kind: 'R' });
    net.delete(oldP);
    net.delete(newP);
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.sortKey), Buffer.from(b.sortKey)));
  return rows.map((r) => r.text);
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const beforeNow = new Map(tree.now);
    const beforeMoves = [...tree.moves];
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of beforeNow) tree.now.set(k, v);
      tree.moves.length = 0;
      tree.moves.push(...beforeMoves);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  const rows = outputRows(tree);
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const nowv = tree.now.get(p)!;
      if (tree.original(p) === nowv) continue;
      if (nowv === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, nowv);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
