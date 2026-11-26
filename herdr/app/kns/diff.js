// Line diff, unified view and three-way merge: the window's merge3.ts (and kns-tui's diff.rs),
// so an edit rebases the same way everywhere.

/** Hunks that turn `a` into `b`: `{a0, a1, lines}` replaces a[a0..a1) with `lines`. */
export function diffLines(a, b) {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const n = a.length - pre - suf, m = b.length - pre - suf;
  if (n === 0 && m === 0) return [];
  if (n === 0 || m === 0 || n * m > 25_000_000) return [{ a0: pre, a1: pre + n, lines: b.slice(pre, pre + m) }];
  const w = m + 1, lcs = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] = a[pre + i] === b[pre + j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0, open = null;
  while (i < n || j < m) {
    if (i < n && j < m && a[pre + i] === b[pre + j]) {
      if (open) { out.push(open); open = null; }
      i++; j++;
      continue;
    }
    open ??= { a0: pre + i, a1: pre + i, lines: [] };
    if (j < m && (i === n || lcs[i * w + j + 1] >= lcs[(i + 1) * w + j])) { open.lines.push(b[pre + j]); j++; }
    else { i++; open.a1 = pre + i; }
  }
  if (open) out.push(open);
  return out;
}

const split = (t) => (t === "" ? [] : t.replace(/\n$/, "").split("\n"));

/** Unified diff rows `{kind: " " | "+" | "-" | "@", text, old?, new?}` with `context` lines. */
export function unified(a, b, context = 3) {
  const la = split(a), lb = split(b), hunks = diffLines(la, lb), out = [];
  let shown = 0, delta = 0;
  hunks.forEach((h, k) => {
    const from = Math.max(h.a0 - context, shown);
    if (from > shown || (k === 0 && from > 0)) out.push({ kind: "@", text: `@@ line ${from + delta + 1} @@` });
    for (let x = from; x < h.a0; x++) out.push({ kind: " ", text: la[x], old: x + 1, new: x + delta + 1 });
    for (let x = h.a0; x < h.a1; x++) out.push({ kind: "-", text: la[x], old: x + 1 });
    h.lines.forEach((l, y) => out.push({ kind: "+", text: l, new: h.a0 + delta + y + 1 }));
    delta += h.lines.length - (h.a1 - h.a0);
    const next = hunks[k + 1]?.a0 ?? la.length;
    const to = Math.min(h.a1 + context, next, la.length);
    for (let x = h.a1; x < to; x++) out.push({ kind: " ", text: la[x], old: x + 1, new: x + delta + 1 });
    shown = to;
  });
  return out;
}

export const MARK_MINE = "<<<<<<< mine", MARK_SEP = "=======", MARK_THEIRS = ">>>>>>> server";

function applyHunks(base, lo, hi, hunks) {
  const out = [];
  let at = lo;
  for (const h of hunks) {
    for (let k = at; k < h.a0; k++) out.push(base[k]);
    out.push(...h.lines);
    at = h.a1;
  }
  for (let k = at; k < hi; k++) out.push(base[k]);
  return out;
}

const same = (a, b) => a.length === b.length && a.every((l, i) => l === b[i]);

/** Replays base→mine onto base→theirs. Overlapping different changes become marked blocks. */
export function merge3(base, mine, theirs) {
  const b = base.split("\n"), hm = diffLines(b, mine.split("\n")), ht = diffLines(b, theirs.split("\n"));
  const out = [];
  let conflicts = 0, at = 0, im = 0, it = 0;
  while (im < hm.length || it < ht.length) {
    const gm = [], gt = [];
    let lo, hi;
    if (im < hm.length && (it >= ht.length || hm[im].a0 <= ht[it].a0)) { lo = hm[im].a0; hi = hm[im].a1; gm.push(hm[im++]); }
    else { lo = ht[it].a0; hi = ht[it].a1; gt.push(ht[it++]); }
    for (;;) {
      if (im < hm.length && hm[im].a0 <= hi && (gt.length > 0 || hm[im].a0 < hi)) { hi = Math.max(hi, hm[im].a1); gm.push(hm[im++]); }
      else if (it < ht.length && ht[it].a0 <= hi && (gm.length > 0 || ht[it].a0 < hi)) { hi = Math.max(hi, ht[it].a1); gt.push(ht[it++]); }
      else break;
    }
    for (let k = at; k < lo; k++) out.push(b[k]);
    at = hi;
    const vm = applyHunks(b, lo, hi, gm), vt = applyHunks(b, lo, hi, gt);
    if (gt.length === 0 || same(vm, vt)) out.push(...vm);
    else if (gm.length === 0) out.push(...vt);
    else { conflicts++; out.push(MARK_MINE, ...vm, MARK_SEP, ...vt, MARK_THEIRS); }
  }
  for (let k = at; k < b.length; k++) out.push(b[k]);
  return { text: out.join("\n"), conflicts };
}

/** 1-based lines with a conflict marker. */
export function conflictLines(text) {
  return text.split("\n").flatMap((l, i) => (l === MARK_MINE || l === MARK_SEP || l === MARK_THEIRS ? [i + 1] : []));
}
