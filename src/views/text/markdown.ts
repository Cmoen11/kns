// A tiny markdown subset for the `text` view: headings, paragraphs, lists, code fences, inline
// code, bold/em and links. The output is data; TextView turns it into React elements from
// ALLOWED_TAGS only. HTML in the source stays literal text, and links become text "label (url)":
// nothing opens a URL.

export type Inline =
  | { t: "text"; text: string }
  | { t: "code"; text: string }
  | { t: "strong"; children: Inline[] }
  | { t: "em"; children: Inline[] };

export type Block =
  | { t: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; children: Inline[] }
  | { t: "paragraph"; children: Inline[] }
  | { t: "list"; ordered: boolean; items: Inline[][] }
  | { t: "code"; info: string; text: string };

/** Every element tag the renderer may create. */
export const ALLOWED_TAGS = ["h1", "h2", "h3", "h4", "h5", "h6", "p", "ul", "ol", "li", "pre", "code", "strong", "em", "span", "div", "section"] as const;
export type AllowedTag = (typeof ALLOWED_TAGS)[number];

/** The element for each block / inline node (TextView renders through this table only). */
export function blockTag(b: Block): AllowedTag {
  switch (b.t) {
    case "heading":
      return `h${b.level}` as AllowedTag;
    case "paragraph":
      return "p";
    case "list":
      return b.ordered ? "ol" : "ul";
    case "code":
      return "pre";
  }
}

export function inlineTag(i: Inline): AllowedTag {
  switch (i.t) {
    case "text":
      return "span";
    case "code":
      return "code";
    case "strong":
      return "strong";
    case "em":
      return "em";
  }
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([^`\s]*)/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const BULLET = /^\s{0,3}[-*+]\s+(.*)$/;
const ORDERED = /^\s{0,3}\d{1,9}[.)]\s+(.*)$/;

export function parseMarkdown(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push({ t: "paragraph", children: parseInline(para.join(" ")) });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const marker = fence[1];
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith(marker)) body.push(lines[i++]);
      out.push({ t: "code", info: fence[2], text: body.join("\n") });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      out.push({ t: "heading", level: heading[1].length as 1 | 2 | 3 | 4 | 5 | 6, children: parseInline(heading[2]) });
      continue;
    }
    const bullet = BULLET.exec(line);
    const ordered = bullet ? null : ORDERED.exec(line);
    if (bullet || ordered) {
      flush();
      const isOrdered = !bullet;
      const re = isOrdered ? ORDERED : BULLET;
      const items: Inline[][] = [];
      let current = (bullet ?? ordered)![1];
      while (++i < lines.length) {
        const next = re.exec(lines[i]);
        if (next) {
          items.push(parseInline(current));
          current = next[1];
        } else if (lines[i].trim() && /^\s{2,}/.test(lines[i])) {
          current += " " + lines[i].trim(); // continuation line
        } else break;
      }
      items.push(parseInline(current));
      i--;
      out.push({ t: "list", ordered: isOrdered, items });
      continue;
    }
    if (!line.trim()) flush();
    else para.push(line.trim());
  }
  flush();
  return out;
}

/** Inline code, links (as text), **bold**, *em* / _em_. Everything else is literal text. */
export function parseInline(s: string): Inline[] {
  const out: Inline[] = [];
  let text = "";
  const push = (node: Inline) => {
    if (text) out.push({ t: "text", text });
    text = "";
    out.push(node);
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "`") {
      const end = s.indexOf("`", i + 1);
      if (end > i) {
        push({ t: "code", text: s.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (c === "[") {
      const m = /^\[([^\]]*)\]\(([^)\s]*)\)/.exec(s.slice(i));
      if (m) {
        text += m[2] && m[2] !== m[1] ? `${m[1]} (${m[2]})` : m[1];
        i += m[0].length;
        continue;
      }
    }
    if (c === "*" && s[i + 1] === "*") {
      const end = s.indexOf("**", i + 2);
      if (end > i + 2) {
        push({ t: "strong", children: parseInline(s.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }
    if ((c === "*" || c === "_") && s[i + 1] && s[i + 1] !== " ") {
      const end = s.indexOf(c, i + 1);
      // `_` only at word boundaries, so snake_case stays literal
      const boundary = c === "*" || ((i === 0 || /\W/.test(s[i - 1])) && (end + 1 >= s.length || /\W/.test(s[end + 1])));
      if (end > i + 1 && s[end - 1] !== " " && boundary) {
        push({ t: "em", children: parseInline(s.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    }
    text += c;
    i++;
  }
  if (text) out.push({ t: "text", text });
  return out;
}

/** Plain text of inline nodes (tests, accessibility labels). */
export function inlineText(nodes: Inline[]): string {
  return nodes.map((n) => (n.t === "text" || n.t === "code" ? n.text : inlineText(n.children))).join("");
}
