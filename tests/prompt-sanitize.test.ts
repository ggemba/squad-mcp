import { describe, it, expect } from "vitest";
import { sanitizeForPrompt as sanitize } from "../src/util/prompt-sanitize.js";

/**
 * Table-driven sanitiser tests. Inputs use `String.fromCodePoint(...)` for
 * invisibles — never raw literals — so prettier / editors can't silently
 * strip the very codepoint under test. Each row pins the strip set for ONE
 * class of attack: control bytes, bidi, zero-width, separators, variation
 * selectors, tag block, role tokens, ligatures, fullwidth, triple-backticks.
 *
 * Coupled with `learning-format-sanitize-property.test.ts` which pins
 * idempotency and strip-set coverage via fast-check.
 *
 * v0.14.x deep-review D4 fix.
 */

interface Row {
  label: string;
  input: string;
  expected: string;
}

describe("sanitizeForPrompt — codepoint strip table", () => {
  const rows: Row[] = [
    // 1. C0/C1 control bytes (except tab / LF / CR).
    {
      label: "C0: BEL U+0007 stripped",
      input: "a" + String.fromCodePoint(0x07) + "b",
      expected: "ab",
    },
    {
      label: "C0: ESC U+001B stripped",
      input: "a" + String.fromCodePoint(0x1b) + "b",
      expected: "ab",
    },
    {
      label: "C0: US U+001F stripped",
      input: "a" + String.fromCodePoint(0x1f) + "b",
      expected: "ab",
    },
    {
      label: "C0: DEL U+007F stripped",
      input: "a" + String.fromCodePoint(0x7f) + "b",
      expected: "ab",
    },
    {
      label: "C1: U+0085 stripped",
      input: "a" + String.fromCodePoint(0x85) + "b",
      expected: "ab",
    },
    {
      label: "C0: TAB preserved",
      input: "a\tb",
      expected: "a\tb",
    },
    {
      label: "C0: LF preserved",
      input: "a\nb",
      expected: "a\nb",
    },
    {
      label: "C0: CR preserved",
      input: "a\rb",
      expected: "a\rb",
    },
    // 2. Bidi controls + Arabic mark.
    {
      label: "bidi: Arabic letter mark U+061C",
      input: "a" + String.fromCodePoint(0x061c) + "b",
      expected: "ab",
    },
    {
      label: "bidi: LRE U+202A",
      input: "a" + String.fromCodePoint(0x202a) + "b",
      expected: "ab",
    },
    {
      label: "bidi: RLO U+202E",
      input: "a" + String.fromCodePoint(0x202e) + "b",
      expected: "ab",
    },
    {
      label: "bidi: FSI U+2068",
      input: "a" + String.fromCodePoint(0x2068) + "b",
      expected: "ab",
    },
    // 3. Zero-width + invisibles.
    {
      label: "invisible: ZWSP U+200B",
      input: "a" + String.fromCodePoint(0x200b) + "b",
      expected: "ab",
    },
    {
      label: "invisible: ZWJ U+200D",
      input: "a" + String.fromCodePoint(0x200d) + "b",
      expected: "ab",
    },
    {
      label: "invisible: soft hyphen U+00AD",
      input: "a" + String.fromCodePoint(0x00ad) + "b",
      expected: "ab",
    },
    {
      label: "invisible: CGJ U+034F",
      input: "a" + String.fromCodePoint(0x034f) + "b",
      expected: "ab",
    },
    {
      label: "invisible: Mongolian VS U+180E",
      input: "a" + String.fromCodePoint(0x180e) + "b",
      expected: "ab",
    },
    {
      label: "invisible: WJ U+2060",
      input: "a" + String.fromCodePoint(0x2060) + "b",
      expected: "ab",
    },
    {
      label: "invisible: BOM U+FEFF",
      input: "a" + String.fromCodePoint(0xfeff) + "b",
      expected: "ab",
    },
    {
      label: "invisible: Hangul filler U+115F",
      input: "a" + String.fromCodePoint(0x115f) + "b",
      expected: "ab",
    },
    {
      label: "invisible: Hangul filler U+1160",
      input: "a" + String.fromCodePoint(0x1160) + "b",
      expected: "ab",
    },
    {
      label: "invisible: Hangul filler U+3164",
      input: "a" + String.fromCodePoint(0x3164) + "b",
      expected: "ab",
    },
    {
      label: "invisible: Khmer U+17B4",
      input: "a" + String.fromCodePoint(0x17b4) + "b",
      expected: "ab",
    },
    {
      label: "invisible: Khmer U+17B5",
      input: "a" + String.fromCodePoint(0x17b5) + "b",
      expected: "ab",
    },
    {
      label: "invisible: Braille blank U+2800",
      input: "a" + String.fromCodePoint(0x2800) + "b",
      expected: "ab",
    },
    // 4. Line / paragraph separators.
    {
      label: "separator: LS U+2028",
      input: "a" + String.fromCodePoint(0x2028) + "b",
      expected: "ab",
    },
    {
      label: "separator: PS U+2029",
      input: "a" + String.fromCodePoint(0x2029) + "b",
      expected: "ab",
    },
    // 5. Variation selectors.
    {
      label: "variation: VS1 U+FE00",
      input: "a" + String.fromCodePoint(0xfe00) + "b",
      expected: "ab",
    },
    {
      label: "variation: VS16 U+FE0F",
      input: "a" + String.fromCodePoint(0xfe0f) + "b",
      expected: "ab",
    },
    // 6. Tag block (steganography channel).
    {
      label: "tag: U+E0001 stripped (above-BMP)",
      input: "a" + String.fromCodePoint(0xe0001) + "b",
      expected: "ab",
    },
    {
      label: "tag: U+E007F (cancel-tag) stripped",
      input: "a" + String.fromCodePoint(0xe007f) + "b",
      expected: "ab",
    },
    {
      label: "tag: U+E0061 (tag-a) stripped",
      input: "a" + String.fromCodePoint(0xe0061) + "b",
      expected: "ab",
    },
    // Role tokens (case-insensitive).
    {
      label: "role: <system> stripped",
      input: "<system>boom</system>",
      expected: "boom",
    },
    {
      label: "role: <SYSTEM> case-insensitive",
      input: "<SYSTEM>boom</SYSTEM>",
      expected: "boom",
    },
    {
      label: "role: <user> stripped",
      input: "<user>x</user>",
      expected: "x",
    },
    {
      label: "role: <assistant> stripped",
      input: "<assistant>x</assistant>",
      expected: "x",
    },
    {
      label: "role: <agent> stripped",
      input: "<agent>x</agent>",
      expected: "x",
    },
    {
      label: "role: <instructions> stripped",
      input: "<instructions>x</instructions>",
      expected: "x",
    },
    {
      label: "role: <instruction> stripped",
      input: "<instruction>x</instruction>",
      expected: "x",
    },
    {
      label: "role: [INST] stripped",
      input: "[INST]hello[/INST]",
      expected: "hello",
    },
    {
      label: "role: [ inst ] tolerant whitespace",
      input: "[ inst ]hello[ /inst ]",
      expected: "hello",
    },
    {
      label: "role: <|im_start|> stripped",
      input: "<|im_start|>hello<|im_end|>",
      expected: "hello",
    },
    {
      label: "role: <|endoftext|> stripped",
      input: "x<|endoftext|>y",
      expected: "xy",
    },
    {
      label: "role: <|begin_of_text|> stripped",
      input: "<|begin_of_text|>z",
      expected: "z",
    },
    {
      label: "role: <|eot_id|> stripped",
      input: "z<|eot_id|>",
      expected: "z",
    },
    // NFKC compatibility decomposition.
    {
      label: "NFKC: fullwidth letters",
      input: "Ｈｅｌｌｏ",
      expected: "Hello",
    },
    {
      label: "NFKC: ligature fi",
      input: "ﬁ",
      expected: "fi",
    },
    {
      label: "NFKC: ligature ffi",
      input: "ﬃ",
      expected: "ffi",
    },
    {
      label: "NFKC: superscript 2",
      input: "x" + String.fromCodePoint(0x00b2),
      expected: "x2",
    },
    // Triple-backticks.
    {
      label: "fence: ``` collapsed to '''",
      input: "say ```bad``` ok",
      expected: "say '''bad''' ok",
    },
    // Idempotency on clean ASCII (NFKC-stable).
    {
      label: "idempotent: plain ASCII unchanged",
      input: "hello, world.",
      expected: "hello, world.",
    },
    {
      label: "idempotent: ASCII with tab and newline",
      input: "a\tb\nc",
      expected: "a\tb\nc",
    },
  ];

  it.each(rows)("$label", ({ input, expected }) => {
    expect(sanitize(input)).toBe(expected);
  });
});

describe("sanitizeForPrompt — composition / interaction", () => {
  it("strips multiple attack vectors in one pass", () => {
    // bidi + zwsp + control + role token + tag block + triple-backtick.
    const evil =
      "lead" +
      String.fromCodePoint(0x202e) +
      "mid" +
      String.fromCodePoint(0x200b) +
      String.fromCodePoint(0x07) +
      "<|im_start|>tail" +
      String.fromCodePoint(0xe0001) +
      "```end```";
    expect(sanitize(evil)).toBe("leadmidtail'''end'''");
  });

  it("does not double-fold NFKC (single normalize call)", () => {
    // NFKC is idempotent on its own output; we just want to confirm the
    // pipeline doesn't reorder NFKC after a strip in a way that changes
    // a result.
    const once = sanitize("Ｈｅｌｌｏ" + String.fromCodePoint(0x200b));
    expect(sanitize(once)).toBe(once);
    expect(once).toBe("Hello");
  });
});
