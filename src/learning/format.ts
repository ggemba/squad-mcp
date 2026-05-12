import { matchesGlob } from "../config/squad-yaml.js";
import { sanitizeForPrompt } from "../util/prompt-sanitize.js";
import type { LearningEntry } from "./store.js";

export interface FormatLearningsOptions {
  /**
   * Filter to learnings whose `scope` glob matches at least one of these
   * paths. Used to narrow per-PR injection to learnings relevant to the
   * files actually changed. When empty / undefined, all entries pass.
   */
  changedFiles?: string[];
  /**
   * Cap the rendered list. Default 50. Tail-most-recent. Hard cap of 200
   * to prevent prompt bloat.
   */
  limit?: number;
  /**
   * Heading level for the section. Default `## Past team decisions`. Adjust
   * when injecting into a prompt that already nests under a higher heading.
   */
  heading?: string;
}

const HARD_LIMIT = 200;
const DEFAULT_LIMIT = 50;
const DEFAULT_HEADING = "## Past team decisions";

/**
 * Render a slice of learning entries as a markdown block ready to inject into
 * an agent or consolidator prompt. Pure function. The block is intentionally
 * compact — each entry is one numbered line so the LLM can scan quickly and
 * reference back ("see decision #4 — already declined this CSRF flag").
 *
 * Returns `''` when no entries qualify after filtering. Callers should check
 * the empty case before injecting (avoid empty headers in prompts).
 */
export function formatLearningsForPrompt(
  entries: LearningEntry[],
  options: FormatLearningsOptions = {},
): string {
  const limit = Math.min(options.limit ?? DEFAULT_LIMIT, HARD_LIMIT);
  const heading = options.heading ?? DEFAULT_HEADING;

  // Filter by scope glob match against changedFiles. An entry without a scope
  // is repo-wide and always passes. An entry WITH a scope passes if any
  // changed file matches the scope glob.
  let relevant = entries;
  if (options.changedFiles && options.changedFiles.length > 0) {
    relevant = entries.filter((e) => {
      if (!e.scope) return true;
      return options.changedFiles!.some((p) => matchesGlob(e.scope!, p));
    });
  }

  // Tail-N most recent. Append order = chronological, so slice from end.
  const tail = relevant.slice(-limit);
  if (tail.length === 0) return "";

  // Render most-recent-first to bias the LLM's attention.
  const ordered = [...tail].reverse();

  const lines: string[] = [];
  lines.push(heading);
  lines.push("");
  lines.push(
    `Recent decisions on similar findings (${ordered.length} of ${entries.length} total, most recent first). When evaluating a new finding that matches a past **rejected** decision (similar agent + similar finding text + matching scope), suppress or downgrade severity. When a finding contradicts a past **accepted** decision, flag the contradiction explicitly.`,
  );
  lines.push("");

  ordered.forEach((e, i) => {
    const ref = e.pr ? `PR #${e.pr}` : e.branch ? `branch ${e.branch}` : e.ts.slice(0, 10);
    const verdict = e.decision === "reject" ? "REJECTED" : "ACCEPTED";
    const sev = e.severity ? ` [${e.severity}]` : "";
    // Sanitize fields that flow VERBATIM into the LLM prompt. `finding` and
    // `reason` are bounded by SafeString at the tool edge (NUL rejected) but
    // control / bidi / zero-width codepoints slip through SafeString. Strip
    // them at render time. `scope` and `branch` get the same treatment because
    // they appear inline in the rendered line and are user-influenceable.
    const safeFinding = sanitizeForPrompt(e.finding);
    const safeScope = e.scope ? sanitizeForPrompt(e.scope) : "";
    const scope = safeScope ? ` (scope: \`${safeScope}\`)` : "";
    // v0.11.0+ : flag promoted entries explicitly so the advisor reads them
    // as team policy rather than ordinary precedent. Matches the SKILL.md
    // "Past-decision interlock" prose that tells agents to treat ⭐ PROMOTED
    // as binding.
    const promotedTag = e.promoted === true ? " ⭐ PROMOTED" : "";
    lines.push(
      `${i + 1}. **${verdict}**${promotedTag} at ${ref}${scope} — ${e.agent}${sev}: "${safeFinding}"`,
    );
    if (e.reason) {
      // Wrap reason in a markdown blockquote (`> `) so the LLM lexically
      // separates user-supplied rationale from surrounding instruction text.
      // Also sanitize for the same reasons as `finding`.
      const safeReason = sanitizeForPrompt(e.reason);
      lines.push(`   > Reason: ${safeReason}`);
    }
  });

  return lines.join("\n") + "\n";
}
