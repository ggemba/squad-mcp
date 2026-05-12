import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { sanitizeForPrompt as sanitize } from "../src/util/prompt-sanitize.js";

/**
 * Property tests for `sanitizeForPrompt`. Two invariants:
 *
 *   1. Idempotency — `sanitize(sanitize(s)) === sanitize(s)` for any input.
 *      If the sanitiser ever introduced a codepoint that itself matched one
 *      of the strip rules (e.g. NFKC after strip producing a new ZWJ), a
 *      second pass would shrink further and the property would fail.
 *
 *   2. Strip-set coverage — `sanitize(s)` never contains a codepoint sampled
 *      from any range in the strip set, regardless of where it was injected.
 *
 * Coupled with `learning-format-sanitize.test.ts` (table tests).
 *
 * v0.14.x deep-review D4 fix.
 */

// One representative codepoint per strip class — keeping the sample small so
// the property runs fast while still covering every documented bucket. Each
// label maps to a comment in the sanitiser source.
const STRIP_SAMPLES: ReadonlyArray<{ label: string; cp: number }> = [
  { label: "C0 BEL", cp: 0x0007 },
  { label: "C0 ESC", cp: 0x001b },
  { label: "C0 US", cp: 0x001f },
  { label: "C0 DEL", cp: 0x007f },
  { label: "C1 NEL", cp: 0x0085 },
  { label: "C1 APC", cp: 0x009f },
  { label: "soft hyphen", cp: 0x00ad },
  { label: "CGJ", cp: 0x034f },
  { label: "Arabic letter mark", cp: 0x061c },
  { label: "Hangul filler 115F", cp: 0x115f },
  { label: "Hangul filler 1160", cp: 0x1160 },
  { label: "Khmer 17B4", cp: 0x17b4 },
  { label: "Khmer 17B5", cp: 0x17b5 },
  { label: "Mongolian VS", cp: 0x180e },
  { label: "ZWSP", cp: 0x200b },
  { label: "ZWNJ", cp: 0x200c },
  { label: "ZWJ", cp: 0x200d },
  { label: "LRM", cp: 0x200e },
  { label: "RLM", cp: 0x200f },
  { label: "LRE", cp: 0x202a },
  { label: "RLO", cp: 0x202e },
  { label: "WJ", cp: 0x2060 },
  { label: "invisible operator 2061", cp: 0x2061 },
  { label: "invisible operator 2064", cp: 0x2064 },
  { label: "FSI", cp: 0x2066 },
  { label: "PDI", cp: 0x2069 },
  { label: "LS U+2028", cp: 0x2028 },
  { label: "PS U+2029", cp: 0x2029 },
  { label: "Braille blank", cp: 0x2800 },
  { label: "Hangul filler 3164", cp: 0x3164 },
  { label: "VS1", cp: 0xfe00 },
  { label: "VS16", cp: 0xfe0f },
  { label: "BOM", cp: 0xfeff },
  { label: "tag start", cp: 0xe0001 },
  { label: "tag-a", cp: 0xe0061 },
  { label: "cancel tag", cp: 0xe007f },
];

describe("sanitizeForPrompt — properties", () => {
  it("idempotent for arbitrary strings (default 100 runs)", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 256 }), (s) => {
        const once = sanitize(s);
        const twice = sanitize(once);
        return once === twice;
      }),
    );
  });

  it("idempotent for unicode strings (broader codepoint coverage)", () => {
    // Default `fc.string` is ASCII-biased; switching `unit: "binary"`
    // covers any codepoint U+0000–U+10FFFF (excluding half-surrogates), so
    // this exercises the NFKC + tag-block paths. (Renamed from
    // `fullUnicodeString` in fast-check v4.)
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 128 }), (s) => {
        const once = sanitize(s);
        const twice = sanitize(once);
        return once === twice;
      }),
    );
  });

  it("output never contains a codepoint from the strip set", () => {
    for (const { label, cp } of STRIP_SAMPLES) {
      const ch = String.fromCodePoint(cp);
      fc.assert(
        fc.property(fc.string({ maxLength: 64 }), fc.string({ maxLength: 64 }), (left, right) => {
          const injected = left + ch + right;
          const out = sanitize(injected);
          // The codepoint must not appear anywhere in the output.
          if (out.includes(ch)) {
            // Surface which class failed so a regression is easy to localise.
            throw new Error(`strip-set leak: ${label} (U+${cp.toString(16)}) survived`);
          }
          return true;
        }),
      );
    }
  });

  it("preserves tab / LF / CR (legitimate whitespace)", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 64 }), fc.string({ maxLength: 64 }), (left, right) => {
        // Construct an input that has only safe whitespace beyond the
        // arbitrary text. Strip any of TAB/LF/CR from the random parts so
        // the count we measure isn't polluted by fc-generated literals.
        const cleanLeft = left.replace(/[\t\n\r]/g, "");
        const cleanRight = right.replace(/[\t\n\r]/g, "");
        const input = cleanLeft + "\t" + cleanLeft + "\n" + cleanRight + "\r" + cleanRight;
        const out = sanitize(input);
        // Sanitisation may collapse other characters but should never strip
        // these three.
        return out.includes("\t") && out.includes("\n") && out.includes("\r");
      }),
    );
  });

  it("clean ASCII strings are NFKC-stable and pass through unchanged", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[\x20-\x7E]*$/u, { maxLength: 128 }), (s) => {
        // Triple-backtick is the only printable-ASCII pattern that
        // sanitisation rewrites; exclude inputs containing it.
        fc.pre(!s.includes("```"));
        // Role-token shapes are also printable ASCII; exclude any input
        // that already matches one (case-insensitive).
        fc.pre(!/<\/?\s*(?:system|user|assistant|agent|instructions?)\s*>/i.test(s));
        fc.pre(!/\[\s*\/?\s*INST\s*\]/i.test(s));
        fc.pre(!/<\|\s*(?:im_start|im_end|endoftext|begin_of_text|eot_id)\s*\|>/i.test(s));
        fc.pre(!/^(?:Human|Assistant)\s*:/im.test(s));
        // The remaining strings are NFKC-stable printable ASCII; sanitise
        // must be a no-op.
        return sanitize(s) === s;
      }),
    );
  });
});

describe("sanitizeForPrompt — explicit strip-set spot checks", () => {
  // Belt-and-braces: the property test catches regressions across the whole
  // sample; these one-shot expectations make a CI failure read clearly.
  it.each(STRIP_SAMPLES)("strips $label (U+$cp)", ({ cp }) => {
    const out = sanitize("x" + String.fromCodePoint(cp) + "y");
    expect(out).not.toContain(String.fromCodePoint(cp));
  });
});
