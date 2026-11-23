// Level detection (docs/ux.md §13.3): only the level token of a line is tinted, with the warn or
// error hue. Detection is deliberately narrow so prose such as "no error" is left alone.

export type Level = "warn" | "error";

export interface LevelHit {
  start: number;
  end: number;
  level: Level;
}

/** only the head of a line is scanned: the level sits near the start */
const SCAN = 160;

const BARE = /(?:^|[^A-Za-z0-9_])(FATAL|PANIC|CRITICAL|CRIT|ERROR|ERRO|ERR|WARNING|WARN|WRN)(?![A-Za-z0-9_])/;
const KEYED = /\b(?:level|lvl|severity)"?\s*[=:]\s*"?(fatal|panic|critical|crit|error|err|warning|warn)\b/i;
const BRACKET = /[[<](fatal|panic|critical|crit|error|err|warning|warn)[\]>]/i;
/** klog: "E0102 15:04:05.000000" */
const KLOG = /^([EWF])\d{4} \d\d:\d\d:\d\d/;

const levelOf = (token: string): Level => (/^w/i.test(token) ? "warn" : "error");

export function detectLevel(text: string): LevelHit | null {
  const head = text.length > SCAN ? text.slice(0, SCAN) : text;
  const klog = KLOG.exec(head);
  if (klog) return { start: 0, end: 1, level: levelOf(klog[1]) };
  let best: LevelHit | null = null;
  for (const re of [BARE, KEYED, BRACKET]) {
    const m = re.exec(head);
    if (!m) continue;
    const start = m.index + m[0].lastIndexOf(m[1]);
    if (!best || start < best.start) best = { start, end: start + m[1].length, level: levelOf(m[1]) };
  }
  return best;
}
