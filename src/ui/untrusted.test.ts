import { describe, expect, it } from "vitest";
import { Untrusted, cleanUntrusted } from "./untrusted";

describe("cleanUntrusted", () => {
  it("strips Unicode tag characters", () => {
    const tagged = "ok" + String.fromCodePoint(0xe0041, 0xe0042, 0xe007f) + "!";
    expect(cleanUntrusted(tagged)).toBe("ok!");
  });

  it("strips bidi controls", () => {
    const s = "a‮b‪c⁦d⁩e‎f‏g‫h⁧";
    expect(cleanUntrusted(s)).toBe("abcdefgh");
  });

  it("strips zero-width characters and BOM", () => {
    expect(cleanUntrusted("﻿z​e‌r‍o⁠")).toBe("zero");
  });

  it("strips ANSI sequences", () => {
    expect(cleanUntrusted("\u001b[31mERROR\u001b[0m x \u001b]0;title\u0007y")).toBe("ERROR x y");
  });

  it("strips control characters and folds line breaks by default", () => {
    expect(cleanUntrusted("a\u0000b\u0007c\u007fd\u0085e")).toBe("abcde");
    expect(cleanUntrusted("line1\r\nline2\tx")).toBe("line1 line2 x");
  });

  it("keeps newlines and tabs in multiline mode", () => {
    expect(cleanUntrusted("a\r\nb\tc\u0000", 500, { multiline: true })).toBe("a\nb\tc");
  });

  it("truncates by code point with an ellipsis", () => {
    expect(cleanUntrusted("abcdef", 4)).toBe("abc…");
    expect(cleanUntrusted("abcd", 4)).toBe("abcd");
    const emoji = "😀😀😀😀😀";
    expect(cleanUntrusted(emoji, 3)).toBe("😀😀…");
  });

  it("keeps ordinary text, including non-Latin scripts", () => {
    expect(cleanUntrusted("æøå — שלום 你好")).toBe("æøå — שלום 你好");
  });
});

describe("Untrusted", () => {
  it("renders cleaned text as a child, isolated and left-to-right", () => {
    const el = Untrusted({ text: "hi‮there" });
    expect(el.type).toBe("q");
    const props = el.props as { dir: string; style: { unicodeBidi: string }; children: string };
    expect(props.dir).toBe("ltr");
    expect(props.style.unicodeBidi).toBe("isolate");
    expect(props.children).toBe("hithere");
  });

  it("puts the label before the text", () => {
    const el = Untrusted({ text: "<b>x</b>", label: "agent's note (unverified)" });
    const [label, body] = (el.props as { children: { props: { children: string } }[] }).children;
    expect(label.props.children).toBe("agent's note (unverified): ");
    expect(body.props.children).toBe("<b>x</b>");
  });
});
