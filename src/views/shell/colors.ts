// Colour parsing (pure). xterm wants plain colours; the --k-* tokens resolve to whatever the browser
// computes (rgb(), rgba(), color(srgb ...), sometimes hex).

const clamp255 = (n: number): number => Math.min(255, Math.max(0, Math.round(n)));
const hex2 = (n: number): string => clamp255(n).toString(16).padStart(2, "0");

function channel(token: string, scale: number): number {
  if (token === "none") return 0;
  if (token.endsWith("%")) return (Number.parseFloat(token) / 100) * scale;
  return Number.parseFloat(token);
}

/**
 * A computed CSS colour as #rrggbb, or #rrggbbaa when it is translucent. null when the value is
 * not one of the forms a computed style produces.
 */
export function cssColorToHex(value: string): string | null {
  const v = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}([0-9a-f]{2})?$/.test(v)) return v;
  if (/^#[0-9a-f]{3}$/.test(v)) return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  if (v === "transparent") return "#00000000";

  let parts: string[] | null = null;
  let scale = 255;
  let m = /^rgba?\(([^)]*)\)$/.exec(v);
  if (m) parts = m[1].split(/[\s,/]+/).filter(Boolean);
  else {
    m = /^color\(\s*srgb\s+([^)]*)\)$/.exec(v);
    if (m) {
      parts = m[1].split(/[\s/]+/).filter(Boolean);
      scale = 1;
    }
  }
  if (!parts || parts.length < 3) return null;
  const rgb = parts.slice(0, 3).map((p) => (scale === 1 ? channel(p, 1) * 255 : channel(p, 255)));
  if (rgb.some((n) => Number.isNaN(n))) return null;
  const alpha = parts.length > 3 ? channel(parts[3], 1) : 1;
  if (Number.isNaN(alpha)) return null;
  const base = `#${hex2(rgb[0])}${hex2(rgb[1])}${hex2(rgb[2])}`;
  return alpha >= 1 ? base : `${base}${hex2(alpha * 255)}`;
}

/** The colour with a new alpha (0..1), as #rrggbbaa. */
export function withAlpha(hex: string, alpha: number): string {
  return `${hex.slice(0, 7)}${hex2(alpha * 255)}`;
}
