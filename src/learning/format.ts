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

  // Filter by scope glob match against changedFiles. An entry without a
  // scope-tag is repo-wide and always passes. An entry WITH a scope-tag
  // passes if any changed file matches that glob. PR2: a v3 row may carry a
  // `trigger` glob instead of (or in addition to) a legacy `scope` — prefer
  // `trigger`, fall back to `scope`. Pure function: this stays
  // version-agnostic (the journaling on/off guard lives at the tool layer).
  let relevant = entries;
  if (options.changedFiles && options.changedFiles.length > 0) {
    relevant = entries.filter((e) => {
      const tag = e.trigger ?? e.scope;
      if (!tag) return true;
      return options.changedFiles!.some((p) => matchesGlob(tag, p));
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
    // Sanitize fields that flow VERBATIM into the LLM prompt. `finding`,
    // `lesson`, `reason`, `trigger`, `scope` are bounded by SafeString at the
    // tool edge (NUL rejected) but control / bidi / zero-width codepoints slip
    // through SafeString. Strip them at render time.
    //
    // PR2: a v3 distilled row carries `lesson` and MAY have no `finding`; a
    // legacy v2 row has `finding` and no `lesson`. Render `lesson ?? finding`
    // as the entry text and `trigger ?? scope` as the scope tag. NEVER call
    // `sanitizeForPrompt(undefined)` — guard each optional field first. The
    // object-level schema refine guarantees at least one of finding/lesson is
    // present, so `entryText` is always a non-empty string.
    const entryText = e.lesson ?? e.finding;
    const safeEntryText = entryText ? sanitizeForPrompt(entryText) : "";
    const scopeTag = e.trigger ?? e.scope;
    const safeScope = scopeTag ? sanitizeForPrompt(scopeTag) : "";
    const scope = safeScope ? ` (scope: \`${safeScope}\`)` : "";
    // v0.11.0+ : flag promoted entries explicitly so the advisor reads them
    // as team policy rather than ordinary precedent. Matches the SKILL.md
    // "Past-decision interlock" prose that tells agents to treat ⭐ PROMOTED
    // as binding.
    const promotedTag = e.promoted === true ? " ⭐ PROMOTED" : "";
    lines.push(
      `${i + 1}. **${verdict}**${promotedTag} at ${ref}${scope} — ${e.agent}${sev}: "${safeEntryText}"`,
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

/**
 * One distilled lesson parsed out of a consolidator's `squad-distilled-lessons`
 * fenced block. `lesson` is the imperative one-liner; `trigger` is an optional
 * retrieval glob.
 */
export interface DistilledLesson {
  lesson: string;
  trigger?: string;
}

/**
 * Parse the `squad-distilled-lessons` fenced block out of consolidator output
 * (PR2 / Fase 1b — C4). The squad skill calls this after the consolidator
 * returns; each returned lesson is recorded via `record_learning`.
 *
 * FAIL-SILENT contract — returns `[]` (never throws) when:
 *  - no fence with the exact info-string `squad-distilled-lessons` is present;
 *  - the fence is partial / unclosed so no body can be extracted;
 *  - the body is not valid JSON;
 *  - the parsed value is not an array;
 *  - (per element) the element is not an object with a non-empty string
 *    `lesson` and an optional string `trigger` — malformed elements are
 *    dropped, valid siblings are kept.
 *
 * The fence is located by its exact info-string: a ```` ```squad-distilled-lessons ````
 * opening line, then the body up to the next closing ```` ``` ```` line. An
 * opening fence with no matching close is treated as absent (fail-silent).
 */
export function parseDistilledLessonsBlock(text: string): DistilledLesson[] {
  if (typeof text !== "string" || text.length === 0) return [];
  const lines = text.split(/\r?\n/);
  let openIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    // Exact info-string match — leading/trailing whitespace tolerated, but the
    // info-string itself must be exactly `squad-distilled-lessons`.
    if (lines[i]!.trim() === "```squad-distilled-lessons") {
      openIdx = i;
      break;
    }
  }
  if (openIdx === -1) return [];

  let closeIdx = -1;
  for (let i = openIdx + 1; i < lines.length; i++) {
    if (lines[i]!.trim() === "```") {
      closeIdx = i;
      break;
    }
  }
  // Unclosed / partial fence — fail-silent.
  if (closeIdx === -1) return [];

  const body = lines
    .slice(openIdx + 1, closeIdx)
    .join("\n")
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: DistilledLesson[] = [];
  for (const el of parsed) {
    if (el === null || typeof el !== "object" || Array.isArray(el)) continue;
    const obj = el as Record<string, unknown>;
    if (typeof obj.lesson !== "string" || obj.lesson.length === 0) continue;
    if (obj.trigger !== undefined && typeof obj.trigger !== "string") continue;
    const lesson: DistilledLesson = { lesson: obj.lesson };
    if (typeof obj.trigger === "string" && obj.trigger.length > 0) {
      lesson.trigger = obj.trigger;
    }
    out.push(lesson);
  }
  return out;
}
