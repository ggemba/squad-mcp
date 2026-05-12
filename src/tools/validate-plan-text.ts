import { z } from "zod";
import type { ToolDef } from "./registry.js";
import { SafeString } from "./_shared/schemas.js";

const schema = z.object({
  plan: SafeString(65_536),
});

type Input = z.infer<typeof schema>;

export type ValidationRule =
  | "GIT_COMMIT_FENCE"
  | "GIT_PUSH_FENCE"
  | "EMOJI_IN_CODE"
  | "IMPL_BEFORE_APPROVAL"
  | "NON_ENGLISH_IDENTIFIER";

export interface ValidationFinding {
  rule: ValidationRule;
  message: string;
  line: number;
  excerpt: string;
}

export interface ValidatePlanOutput {
  findings: ValidationFinding[];
  advisory: true;
}

const NON_ENGLISH_IDENT_HEURISTIC =
  /\b(salvar|cadastrar|atualizar|deletar|consultar|listar|buscar|criar|remover|exibir|guardar)\w*\s*\(/;

const EMOJI_REGEX = /[\u{1F000}-\u{1FFFF}]|[\u{2600}-\u{27BF}]/u;

const GIT_COMMIT_FENCE_REGEX = /^\s*git\s+commit\b/m;
const GIT_PUSH_FENCE_REGEX = /^\s*git\s+push\b/m;

const APPROVAL_MARKERS_REGEX = /\b(approved|aprovado|plan approved|sign[- ]off)\b/i;
const IMPL_VERBS_REGEX =
  /^\s*(start(ing)?|begin(ing|ning)?|let(?:'s| us)?\s+(?:start|begin|implement|code))/im;

function extractCodeBlocks(text: string): { content: string; startLine: number }[] {
  const blocks: { content: string; startLine: number }[] = [];
  const lines = text.split("\n");
  let inBlock = false;
  let buf: string[] = [];
  let blockStart = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trimStart().startsWith("```")) {
      if (inBlock) {
        blocks.push({ content: buf.join("\n"), startLine: blockStart + 1 });
        buf = [];
        inBlock = false;
      } else {
        inBlock = true;
        blockStart = i + 1;
      }
    } else if (inBlock) {
      buf.push(line);
    }
  }
  return blocks;
}

function lineOfMatch(text: string, idx: number): number {
  return text.slice(0, idx).split("\n").length;
}

export function validatePlanText(input: Input): ValidatePlanOutput {
  const findings: ValidationFinding[] = [];
  // NOTE: this tool intentionally does NOT apply `sanitizeForPrompt`. It is a
  // VALIDATOR that searches for dangerous patterns INSIDE markdown code fences
  // (`extractCodeBlocks` below depends on the triple-backtick syntax surviving),
  // not a RENDERER that interpolates the value into an LLM prompt. The render
  // boundary for `plan` is handled upstream by `compose_advisory_bundle` (which
  // sanitizes before passing the plan to LLM-prompt builders). NUL-byte defence
  // here is provided by `SafeString(65_536)` on the schema (line 7). Adding
  // sanitize here would collapse the fences this validator is supposed to
  // inspect — see v0.14.x deep-review D5 Gate-8 halt.
  const text = input.plan;

  const blocks = extractCodeBlocks(text);
  for (const blk of blocks) {
    const emojiMatch = blk.content.match(EMOJI_REGEX);
    if (emojiMatch && emojiMatch.index !== undefined) {
      findings.push({
        rule: "EMOJI_IN_CODE",
        message: "emoji inside code block",
        line: blk.startLine + blk.content.slice(0, emojiMatch.index).split("\n").length - 1,
        excerpt: emojiMatch[0],
      });
    }

    const identMatch = blk.content.match(NON_ENGLISH_IDENT_HEURISTIC);
    if (identMatch && identMatch.index !== undefined) {
      findings.push({
        rule: "NON_ENGLISH_IDENTIFIER",
        message: `non-English identifier in code block: ${identMatch[0].trim()}`,
        line: blk.startLine + blk.content.slice(0, identMatch.index).split("\n").length - 1,
        excerpt: identMatch[0].slice(0, 80),
      });
    }

    const commitMatch = blk.content.match(GIT_COMMIT_FENCE_REGEX);
    if (commitMatch && commitMatch.index !== undefined) {
      findings.push({
        rule: "GIT_COMMIT_FENCE",
        message:
          'plan shows "git commit" inside a code block; commits are not part of the squad-dev workflow',
        line: blk.startLine + blk.content.slice(0, commitMatch.index).split("\n").length - 1,
        excerpt: commitMatch[0].trim(),
      });
    }
    const pushMatch = blk.content.match(GIT_PUSH_FENCE_REGEX);
    if (pushMatch && pushMatch.index !== undefined) {
      findings.push({
        rule: "GIT_PUSH_FENCE",
        message:
          'plan shows "git push" inside a code block; pushes are not part of the squad-dev workflow',
        line: blk.startLine + blk.content.slice(0, pushMatch.index).split("\n").length - 1,
        excerpt: pushMatch[0].trim(),
      });
    }
  }

  const approvalIdx = text.search(APPROVAL_MARKERS_REGEX);
  const implIdx = text.search(IMPL_VERBS_REGEX);
  if (implIdx !== -1 && (approvalIdx === -1 || implIdx < approvalIdx)) {
    findings.push({
      rule: "IMPL_BEFORE_APPROVAL",
      message: "implementation directive appears before any approval marker",
      line: lineOfMatch(text, implIdx),
      excerpt: text.slice(implIdx, implIdx + 80).trim(),
    });
  }

  return { findings, advisory: true };
}

export const validatePlanTextTool: ToolDef<typeof schema> = {
  name: "validate_plan_text",
  description:
    "Heuristic check for inviolable rule violations in a plan text: git commit/push fences, emojis in code blocks, " +
    "non-English identifiers in code blocks, implementation-before-approval markers. Advisory only — never blocking.",
  schema,
  handler: validatePlanText,
};
