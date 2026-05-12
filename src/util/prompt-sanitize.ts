/**
 * Strip characters that an attacker (or unwary user) could use to manipulate
 * the LLM that renders the resulting prompt. Defence-in-depth — the schema
 * `SafeString` already rejects NUL at the tool boundary; this catches the
 * larger class of prompt-injection vectors at the render boundary because
 * `reason` and `finding` flow verbatim into agent / consolidator prompts.
 *
 * NFKC normalisation is applied FIRST (compatibility decomposition) so
 * lookalike forms — fullwidth ASCII (Ｈｅｌｌｏ → Hello), ligatures (ﬁ → fi),
 * compatibility variants — collapse to their canonical codepoints before
 * pattern-matching. NFKC at render only — the on-disk journal retains the
 * original codepoints so the audit trail is byte-faithful.
 *
 * All regexes carry the `u` flag for grapheme-cluster consistency; the tag
 * block (U+E0000–U+E007F) is outside the BMP and REQUIRES `u` to match.
 * Each regex uses `\u{...}` escapes (rather than literal codepoints) so the
 * source survives formatters that re-flow whitespace and so dangerous
 * codepoints like U+2028 (which is a line terminator in JS source) don't
 * break the regex literal at parse time.
 *
 * Removed character classes (rationale next to each, one regex per class
 * so the doc lines up with the implementation):
 *   1. C0/C1 control bytes except `\t \n \r` (U+0000–U+0008, U+000B–U+000C,
 *      U+000E–U+001F, U+007F–U+009F) — terminal escape injection, malformed
 *      line interpretation in the journal.
 *   2. Bidi controls + Arabic mark (U+061C, U+202A–U+202E, U+2066–U+2069) —
 *      RTL/LTR override attacks that re-order rendered characters visually.
 *   3. Zero-width + invisible joiners + soft hyphen (U+00AD) + CGJ
 *      (U+034F) + Mongolian VS (U+180E) + WJ (U+2060) + invisible
 *      operators (U+2061–U+2064) + BOM (U+FEFF) + Hangul fillers (U+115F,
 *      U+1160, U+3164) + Khmer invisible vowels (U+17B4–U+17B5) + Braille
 *      blank (U+2800) — hide payloads inside otherwise-innocuous strings
 *      (e.g. instruction tokens between visible characters).
 *   4. Line / paragraph separators (U+2028, U+2029) — alternative line
 *      terminators the LLM may interpret as instruction-break boundaries.
 *   5. Variation selectors (U+FE00–U+FE0F) — pair with preceding codepoints
 *      to change visual rendering without changing semantics; abused for
 *      steganography.
 *   6. Tag block (U+E0000–U+E007F) — Unicode "tag" characters; a known
 *      steganography channel for prompt injection.
 *
 * Then role-token shapes are stripped (case-insensitive): turn markers
 * like `<system>`, `</user>`, `[INST]`, `<|im_start|>`, `<|eot_id|>`. The
 * REFUSE check in `record-learning.ts` rejects these at the boundary for
 * `reason`; sanitisation here is the silent-strip fallback for `finding`
 * (which may legitimately quote injection patterns in titles).
 *
 * Finally triple-backticks collapse to triple single-quotes so a quoted
 * snippet can never close an enclosing code fence in the rendered prompt.
 *
 * v0.11.0 cycle-2 Blocker B3 (initial cut). v0.14.x deep-review D4 expands
 * the strip set and adds NFKC + role-token + triple-backtick handling.
 *
 * Centralised at src/util/prompt-sanitize.ts since v0.14.x D5 — used by every
 * MCP-tool boundary that accepts user-supplied text and renders it back as
 * LLM prompt content.
 */
export function sanitizeForPrompt(s: string): string {
  return (
    s
      // NFKC at render only — journal retains original codepoints.
      .normalize("NFKC")
      // 1. C0/C1 control bytes except tab / LF / CR.
      //    U+0000–U+0008, U+000B–U+000C, U+000E–U+001F, U+007F–U+009F.
      .replace(/[\u{0000}-\u{0008}\u{000B}\u{000C}\u{000E}-\u{001F}\u{007F}-\u{009F}]/gu, "")
      // 2. Bidi controls + Arabic mark.
      //    U+061C, U+202A–U+202E, U+2066–U+2069.
      .replace(/[\u{061C}\u{202A}-\u{202E}\u{2066}-\u{2069}]/gu, "")
      // 3. Zero-width + invisible joiners + soft hyphen + CGJ + Mongolian VS
      //    + WJ + invisible operators + BOM + Hangul fillers (U+115F, U+1160,
      //    U+3164) + Khmer invisible vowels (U+17B4–U+17B5) + Braille blank
      //    (U+2800).
      .replace(
        /[\u{00AD}\u{034F}\u{115F}\u{1160}\u{17B4}\u{17B5}\u{180E}\u{200B}-\u{200F}\u{2060}-\u{2064}\u{2800}\u{3164}\u{FEFF}]/gu,
        "",
      )
      // 4. Line / paragraph separators.
      //    U+2028, U+2029.
      .replace(/[\u{2028}\u{2029}]/gu, "")
      // 5. Variation selectors.
      //    U+FE00–U+FE0F.
      .replace(/[\u{FE00}-\u{FE0F}]/gu, "")
      // 6. Tag block (steganography channel).
      //    MUST keep 'u' flag — Unicode tag block requires it (codepoints
      //    above the BMP cannot appear in a character class without `u`).
      .replace(/[\u{E0000}-\u{E007F}]/gu, "")
      // Role-token shapes (case-insensitive). Strip outright so a sanitised
      // line cannot read as an open / close turn boundary downstream.
      .replace(/<\/?\s*(?:system|user|assistant|agent|instructions?)\s*>/giu, "")
      .replace(/\[\s*\/?\s*INST\s*\]/giu, "")
      .replace(/<\|\s*(?:im_start|im_end|endoftext|begin_of_text|eot_id)\s*\|>/giu, "")
      // Triple-backticks → triple single-quotes so an embedded fence cannot
      // close the enclosing code block in the rendered prompt.
      .replace(/```/gu, "'''")
  );
}
