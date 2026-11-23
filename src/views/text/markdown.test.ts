import { describe, expect, it } from "vitest";
import { ALLOWED_TAGS, blockTag, inlineTag, inlineText, parseInline, parseMarkdown, type Block, type Inline } from "./markdown";

describe("parseMarkdown", () => {
  it("parses headings of every level", () => {
    const blocks = parseMarkdown("# One\n## Two ##\n###### Six");
    expect(blocks.map((b) => (b.t === "heading" ? [b.level, inlineText(b.children)] : null))).toEqual([
      [1, "One"],
      [2, "Two"],
      [6, "Six"],
    ]);
    expect(parseMarkdown("####### seven")[0].t).toBe("paragraph");
  });

  it("joins paragraph lines and splits on blank lines", () => {
    const blocks = parseMarkdown("first line\nsecond line\n\nnext");
    expect(blocks).toEqual([
      { t: "paragraph", children: [{ t: "text", text: "first line second line" }] },
      { t: "paragraph", children: [{ t: "text", text: "next" }] },
    ]);
  });

  it("parses unordered and ordered lists", () => {
    const blocks = parseMarkdown("- a\n* b\n  continued\n\n1. one\n2) two");
    expect(blocks).toHaveLength(2);
    const [ul, ol] = blocks as Extract<Block, { t: "list" }>[];
    expect(ul.ordered).toBe(false);
    expect(ul.items.map(inlineText)).toEqual(["a", "b continued"]);
    expect(ol.ordered).toBe(true);
    expect(ol.items.map(inlineText)).toEqual(["one", "two"]);
  });

  it("keeps code fences verbatim, with the info string", () => {
    const blocks = parseMarkdown("```text source=logs\n# not a heading\n  - not a list\n```\nafter");
    expect(blocks[0]).toEqual({ t: "code", info: "text", text: "# not a heading\n  - not a list" });
    expect(blocks[1].t).toBe("paragraph");
  });

  it("handles an unterminated fence", () => {
    expect(parseMarkdown("```\nopen")).toEqual([{ t: "code", info: "", text: "open" }]);
  });

  it("keeps HTML as literal text", () => {
    const blocks = parseMarkdown('<script>alert(1)</script>\n<img src=x onerror="y">');
    expect(blocks).toEqual([{ t: "paragraph", children: [{ t: "text", text: '<script>alert(1)</script> <img src=x onerror="y">' }] }]);
  });
});

describe("parseInline", () => {
  it("turns links into text, never a URL node", () => {
    expect(parseInline("see [docs](https://example.com/x) now")).toEqual([{ t: "text", text: "see docs (https://example.com/x) now" }]);
    expect(parseInline("[https://a.b](https://a.b)")).toEqual([{ t: "text", text: "https://a.b" }]);
    expect(parseInline("[javascript](javascript:alert(1))")[0]).toEqual({ t: "text", text: expect.stringContaining("javascript") });
  });

  it("parses inline code, bold and em", () => {
    expect(parseInline("run `kubectl get` **now** or *later*")).toEqual([
      { t: "text", text: "run " },
      { t: "code", text: "kubectl get" },
      { t: "text", text: " " },
      { t: "strong", children: [{ t: "text", text: "now" }] },
      { t: "text", text: " or " },
      { t: "em", children: [{ t: "text", text: "later" }] },
    ]);
  });

  it("leaves snake_case and stray markers alone", () => {
    expect(inlineText(parseInline("DB_PASSWORD_FILE and 2 * 3"))).toBe("DB_PASSWORD_FILE and 2 * 3");
    expect(parseInline("DB_PASSWORD_FILE")).toEqual([{ t: "text", text: "DB_PASSWORD_FILE" }]);
  });
});

describe("renderer tags", () => {
  const allowed = new Set<string>(ALLOWED_TAGS);
  const walk = (nodes: Inline[]): string[] =>
    nodes.flatMap((n) => [inlineTag(n), ...(n.t === "strong" || n.t === "em" ? walk(n.children) : [])]);

  it("maps every block and inline node to an allowlisted tag", () => {
    const doc = parseMarkdown(
      "# h\n## h2\n### h3\n#### h4\n##### h5\n###### h6\npara `c` **b *e* b** [l](u)\n\n- x\n1. y\n```\ncode\n```\n<div onclick=x>",
    );
    const tags = doc.flatMap((b) => {
      const inner = b.t === "heading" || b.t === "paragraph" ? walk(b.children) : b.t === "list" ? ["li", ...b.items.flatMap(walk)] : ["code"];
      return [blockTag(b), ...inner];
    });
    expect(tags.length).toBeGreaterThan(10);
    expect(tags.filter((t) => !allowed.has(t))).toEqual([]);
  });
});
