// Line-based three-way merge for the edit rebase (docs/ux.md §13.2 step 6). Pure.

export interface Hunk {
  /** [a0, a1) in the base is replaced by `lines` */
  a0: number;
  a1: number;
  lines: string[];
}

/** Hunks that turn `a` into `b` (LCS over lines, common prefix and suffix trimmed first). */
export function diffLines(a: readonly string[], b: readonly string[]): Hunk[] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const n = a.length - pre - suf;
  const m = b.length - pre - suf;
  if (n === 0 && m === 0) return [];
  if (n === 0 || m === 0) return [{ a0: pre, a1: pre + n, lines: b.slice(pre, pre + m) }];

  // LCS lengths, suffix form: lcs[i][j] for a[pre+i..], b[pre+j..]
  const w = m + 1;
  const lcs = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] = a[pre + i] === b[pre + j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
    }
  }
  const out: Hunk[] = [];
  let i = 0;
  let j = 0;
  let open: Hunk | null = null;
  const flush = () => {
    if (open) out.push(open);
    open = null;
  };
  while (i < n || j < m) {
    if (i < n && j < m && a[pre + i] === b[pre + j]) {
      flush();
      i++;
      j++;
      continue;
    }
    open ??= { a0: pre + i, a1: pre + i, lines: [] };
    if (j < m && (i === n || lcs[i * w + j + 1] >= lcs[(i + 1) * w + j])) {
      open.lines.push(b[pre + j]);
      j++;
    } else {
      i++;
      open.a1 = pre + i;
    }
  }
  flush();
  return out;
}

export interface MergeResult {
  text: string;
  /** number of conflict blocks written with markers */
  conflicts: number;
}

export const MARK_MINE = "<<<<<<< mine";
export const MARK_SEP = "=======";
export const MARK_THEIRS = ">>>>>>> server";

function applyHunks(base: readonly string[], lo: number, hi: number, hunks: readonly Hunk[]): string[] {
  const out: string[] = [];
  let at = lo;
  for (const h of hunks) {
    for (let k = at; k < h.a0; k++) out.push(base[k]);
    out.push(...h.lines);
    at = h.a1;
  }
  for (let k = at; k < hi; k++) out.push(base[k]);
  return out;
}

const sameLines = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((l, i) => l === b[i]);

/**
 * Replays the user's changes (base -> mine) onto the new server version (base -> theirs).
 * Changes that touch the same or adjacent base lines and differ become a conflict block.
 */
export function merge3(base: string, mine: string, theirs: string): MergeResult {
  const b = base.split("\n");
  const hm = diffLines(b, mine.split("\n"));
  const ht = diffLines(b, theirs.split("\n"));
  const out: string[] = [];
  let conflicts = 0;
  let at = 0;
  let im = 0;
  let it = 0;
  while (im < hm.length || it < ht.length) {
    const nm = hm[im];
    const nt = ht[it];
    // start a region at the earliest hunk and grow it while hunks of either side touch it
    let lo: number;
    let hi: number;
    const gm: Hunk[] = [];
    const gt: Hunk[] = [];
    if (nm && (!nt || nm.a0 <= nt.a0)) {
      lo = nm.a0;
      hi = nm.a1;
      gm.push(nm);
      im++;
    } else {
      lo = nt.a0;
      hi = nt.a1;
      gt.push(nt);
      it++;
    }
    for (;;) {
      if (im < hm.length && hm[im].a0 <= hi && (gt.length > 0 || hm[im].a0 < hi)) {
        hi = Math.max(hi, hm[im].a1);
        gm.push(hm[im++]);
      } else if (it < ht.length && ht[it].a0 <= hi && (gm.length > 0 || ht[it].a0 < hi)) {
        hi = Math.max(hi, ht[it].a1);
        gt.push(ht[it++]);
      } else break;
    }
    for (let k = at; k < lo; k++) out.push(b[k]);
    at = hi;
    const vm = applyHunks(b, lo, hi, gm);
    const vt = applyHunks(b, lo, hi, gt);
    if (gt.length === 0 || sameLines(vm, vt)) out.push(...vm);
    else if (gm.length === 0) out.push(...vt);
    else {
      conflicts++;
      out.push(MARK_MINE, ...vm, MARK_SEP, ...vt, MARK_THEIRS);
    }
  }
  for (let k = at; k < b.length; k++) out.push(b[k]);
  return { text: out.join("\n"), conflicts };
}

/** 1-based lines that carry a conflict marker. */
export function conflictMarkerLines(text: string): number[] {
  const out: number[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l === MARK_MINE || l === MARK_SEP || l === MARK_THEIRS) out.push(i + 1);
  }
  return out;
}
