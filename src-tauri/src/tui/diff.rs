//! Line diffs for the review view and the three-way merge for a rebase (a port of
//! `src/views/doc/merge3.ts`, so the TUI and the window merge the same way).

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hunk {
    /// `[a0, a1)` of the base is replaced by `lines`
    pub a0: usize,
    pub a1: usize,
    pub lines: Vec<String>,
}

/// Hunks that turn `a` into `b` (LCS over lines, common prefix and suffix trimmed first).
pub fn diff_lines(a: &[String], b: &[String]) -> Vec<Hunk> {
    let mut pre = 0;
    while pre < a.len() && pre < b.len() && a[pre] == b[pre] {
        pre += 1;
    }
    let mut suf = 0;
    while suf < a.len() - pre && suf < b.len() - pre && a[a.len() - 1 - suf] == b[b.len() - 1 - suf] {
        suf += 1;
    }
    let n = a.len() - pre - suf;
    let m = b.len() - pre - suf;
    if n == 0 && m == 0 {
        return vec![];
    }
    if n == 0 || m == 0 {
        return vec![Hunk { a0: pre, a1: pre + n, lines: b[pre..pre + m].to_vec() }];
    }
    // a very large change: one hunk instead of an n×m table
    if n.saturating_mul(m) > 25_000_000 {
        return vec![Hunk { a0: pre, a1: pre + n, lines: b[pre..pre + m].to_vec() }];
    }
    let w = m + 1;
    let mut lcs = vec![0u32; (n + 1) * w];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            lcs[i * w + j] = if a[pre + i] == b[pre + j] { lcs[(i + 1) * w + j + 1] + 1 } else { lcs[(i + 1) * w + j].max(lcs[i * w + j + 1]) };
        }
    }
    let mut out = vec![];
    let (mut i, mut j) = (0, 0);
    let mut open: Option<Hunk> = None;
    while i < n || j < m {
        if i < n && j < m && a[pre + i] == b[pre + j] {
            out.extend(open.take());
            i += 1;
            j += 1;
            continue;
        }
        let h = open.get_or_insert_with(|| Hunk { a0: pre + i, a1: pre + i, lines: vec![] });
        if j < m && (i == n || lcs[i * w + j + 1] >= lcs[(i + 1) * w + j]) {
            h.lines.push(b[pre + j].clone());
            j += 1;
        } else {
            i += 1;
            h.a1 = pre + i;
        }
    }
    out.extend(open);
    out
}

pub const MARK_MINE: &str = "<<<<<<< mine";
pub const MARK_SEP: &str = "=======";
pub const MARK_THEIRS: &str = ">>>>>>> server";

fn apply_hunks(base: &[String], lo: usize, hi: usize, hunks: &[&Hunk]) -> Vec<String> {
    let mut out = vec![];
    let mut at = lo;
    for h in hunks {
        out.extend_from_slice(&base[at..h.a0]);
        out.extend(h.lines.iter().cloned());
        at = h.a1;
    }
    out.extend_from_slice(&base[at..hi]);
    out
}

fn split(text: &str) -> Vec<String> {
    text.split('\n').map(str::to_string).collect()
}

/// Replays `base → mine` onto `base → theirs`; overlapping different changes become marked
/// blocks. Returns the text and the number of conflict blocks.
pub fn merge3(base: &str, mine: &str, theirs: &str) -> (String, usize) {
    let b = split(base);
    let hm = diff_lines(&b, &split(mine));
    let ht = diff_lines(&b, &split(theirs));
    let mut out: Vec<String> = vec![];
    let (mut conflicts, mut at, mut im, mut it) = (0, 0, 0, 0);
    while im < hm.len() || it < ht.len() {
        let (mut gm, mut gt): (Vec<&Hunk>, Vec<&Hunk>) = (vec![], vec![]);
        let (lo, mut hi);
        if im < hm.len() && (it >= ht.len() || hm[im].a0 <= ht[it].a0) {
            lo = hm[im].a0;
            hi = hm[im].a1;
            gm.push(&hm[im]);
            im += 1;
        } else {
            lo = ht[it].a0;
            hi = ht[it].a1;
            gt.push(&ht[it]);
            it += 1;
        }
        loop {
            if im < hm.len() && hm[im].a0 <= hi && (!gt.is_empty() || hm[im].a0 < hi) {
                hi = hi.max(hm[im].a1);
                gm.push(&hm[im]);
                im += 1;
            } else if it < ht.len() && ht[it].a0 <= hi && (!gm.is_empty() || ht[it].a0 < hi) {
                hi = hi.max(ht[it].a1);
                gt.push(&ht[it]);
                it += 1;
            } else {
                break;
            }
        }
        out.extend_from_slice(&b[at..lo]);
        at = hi;
        let vm = apply_hunks(&b, lo, hi, &gm);
        let vt = apply_hunks(&b, lo, hi, &gt);
        if gt.is_empty() || vm == vt {
            out.extend(vm);
        } else if gm.is_empty() {
            out.extend(vt);
        } else {
            conflicts += 1;
            out.push(MARK_MINE.into());
            out.extend(vm);
            out.push(MARK_SEP.into());
            out.extend(vt);
            out.push(MARK_THEIRS.into());
        }
    }
    out.extend_from_slice(&b[at..]);
    (out.join("\n"), conflicts)
}

/// 1-based lines that carry a conflict marker.
pub fn conflict_markers(text: &str) -> Vec<usize> {
    text.split('\n').enumerate().filter(|(_, l)| [MARK_MINE, MARK_SEP, MARK_THEIRS].contains(l)).map(|(i, _)| i + 1).collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Same,
    Add,
    Del,
    /// `@@ -a,+b @@` between hunks
    Gap,
}

/// A unified diff of `a` → `b` with `context` lines around each change.
pub fn unified(a: &str, b: &str, context: usize) -> Vec<(Kind, String)> {
    let (la, lb) = (split(a.trim_end_matches('\n')), split(b.trim_end_matches('\n')));
    let la = if a.is_empty() { vec![] } else { la };
    let lb = if b.is_empty() { vec![] } else { lb };
    let hunks = diff_lines(&la, &lb);
    let mut out = vec![];
    let mut shown_to = 0; // base lines [0, shown_to) are already out
    let mut delta: isize = 0; // b index = a index + delta
    for (k, h) in hunks.iter().enumerate() {
        let from = h.a0.saturating_sub(context).max(shown_to);
        if from > shown_to || (k == 0 && from > 0) {
            out.push((Kind::Gap, format!("@@ line {} @@", (from as isize + delta + 1).max(1))));
        }
        for l in &la[from..h.a0] {
            out.push((Kind::Same, l.clone()));
        }
        for l in &la[h.a0..h.a1] {
            out.push((Kind::Del, l.clone()));
        }
        for l in &h.lines {
            out.push((Kind::Add, l.clone()));
        }
        delta += h.lines.len() as isize - (h.a1 - h.a0) as isize;
        let next = hunks.get(k + 1).map(|n| n.a0).unwrap_or(la.len());
        let to = (h.a1 + context).min(next).min(la.len());
        for l in &la[h.a1..to] {
            out.push((Kind::Same, l.clone()));
        }
        shown_to = to;
    }
    out
}

/// `+added -removed` line counts of a unified diff.
pub fn stat(d: &[(Kind, String)]) -> (usize, usize) {
    (d.iter().filter(|(k, _)| *k == Kind::Add).count(), d.iter().filter(|(k, _)| *k == Kind::Del).count())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merges_disjoint_changes_and_marks_overlaps() {
        let base = "a\nb\nc\nd\ne";
        let (text, n) = merge3(base, "a\nB\nc\nd\ne", "a\nb\nc\nd\nE");
        assert_eq!((text.as_str(), n), ("a\nB\nc\nd\nE", 0));
        let (text, n) = merge3(base, "a\nB\nc\nd\ne", "a\nX\nc\nd\ne");
        assert_eq!(n, 1);
        assert_eq!(conflict_markers(&text), vec![2, 4, 6]);
        // the same change on both sides is no conflict
        assert_eq!(merge3(base, "a\nB\nc", "a\nB\nc").1, 0);
    }

    #[test]
    fn unified_diff_has_context_and_gaps() {
        let a = (1..=20).map(|i| i.to_string()).collect::<Vec<_>>().join("\n");
        let b = a.replace("\n10\n", "\nten\n");
        let d = unified(&a, &b, 2);
        let kinds: Vec<Kind> = d.iter().map(|x| x.0).collect();
        assert_eq!(kinds, vec![Kind::Gap, Kind::Same, Kind::Same, Kind::Del, Kind::Add, Kind::Same, Kind::Same]);
        assert_eq!(d[0].1, "@@ line 8 @@");
        assert_eq!(stat(&d), (1, 1));
        assert!(unified(&a, &a, 3).is_empty());
        // a new object: everything added
        assert_eq!(stat(&unified("", "x: 1\ny: 2\n", 3)), (2, 0));
    }
}
