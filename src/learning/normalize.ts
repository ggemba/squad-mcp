/**
 * Canonical title normalisation for matching learnings against live findings
 * and for grouping during promotion-recurrence counting.
 *
 * Single source of truth — used by:
 *   - `read_learnings` rendering: when a live finding's title normalises to
 *     the same key as a past learning's, the past learning is inlined next
 *     to the relevant finding context in the advisory prompt (v0.11.0+).
 *   - `prune_learnings`: groups entries by normalised title to count
 *     accept-decisions and mark the most-recent matching entry as
 *     `promoted: true` when count ≥ `min_recurrence`.
 *
 * Strategy:
 *   - Lowercase for case-insensitivity ("CSRF Token Missing" ≡ "csrf token missing").
 *   - Strip leading/trailing whitespace.
 *   - Collapse runs of internal whitespace to a single space.
 *   - Strip a small set of common punctuation that's noise-vs-signal at
 *     finding granularity: trailing `.`, surrounding `"` `'` ``` `` `, and
 *     parenthetical suffixes (often line numbers like ` (line 42)` or
 *     ` (#1234)`). Inner punctuation stays — `auth.middleware.ts` matters
 *     for disambiguation.
 *
 * Conservative on purpose: this is exact-match-after-normalisation, NOT
 * fuzzy similarity. Plan v2 deferred TF-IDF / embedding-based similarity to
 * a future release. If the team wants "this finding is the same as past
 * one with different wording", they record it explicitly.
 */
export function normalizeFindingTitle(s: string): string {
  if (typeof s !== "string") return "";
  // PASS ORDER IS LOAD-BEARING. Changing the order changes the equivalence
  // class that `prune_learnings` uses for promotion grouping — invalidating
  // every promoted entry's recurrence count on the next prune. If you need
  // to tweak this function, do it via additive passes, not reorderings.
  let out = s.toLowerCase().trim();
  // Strip a single trailing `.` / `,` / `;`.
  out = out.replace(/[.,;]+$/, "");
  // Strip surrounding quotes / backticks — only when BOTH sides match the
  // same quote character. v0.11.0 cycle-2 (developer Major M6) fix: the
  // earlier `^[`'"](.+)[`'"]$` accepted mismatched pairs (e.g. `"foo'`)
  // which collapsed to `foo`, surprising future maintainers. Apply each
  // quote class independently so only true pairs strip.
  out = out.replace(/^`(.+)`$/, "$1");
  out = out.replace(/^'(.+)'$/, "$1");
  out = out.replace(/^"(.+)"$/, "$1");
  // Strip a single trailing parenthetical suffix `(...)`. Line numbers,
  // PR refs, agent attributions all get noise-suppressed.
  out = out.replace(/\s*\([^)]*\)\s*$/, "");
  // Collapse internal whitespace to single space.
  out = out.replace(/\s+/g, " ");
  // Trim again in case the parenthetical strip exposed trailing whitespace.
  return out.trim();
}
