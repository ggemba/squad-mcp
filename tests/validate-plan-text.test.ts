import { describe, it, expect } from 'vitest';
import { validatePlanText } from '../src/tools/validate-plan-text.js';

const code = (s: string) => '```ts\n' + s + '\n```';

describe('validatePlanText', () => {
  describe('positive findings', () => {
    it('flags git commit fence', () => {
      const r = validatePlanText({ plan: code('git commit -m "x"') });
      expect(r.findings.some((f) => f.rule === 'GIT_COMMIT_FENCE')).toBe(true);
    });

    it('flags git push fence', () => {
      const r = validatePlanText({ plan: code('git push origin main') });
      expect(r.findings.some((f) => f.rule === 'GIT_PUSH_FENCE')).toBe(true);
    });

    it('flags emoji in code block', () => {
      const r = validatePlanText({ plan: code('console.log("done ✅")') });
      expect(r.findings.some((f) => f.rule === 'EMOJI_IN_CODE')).toBe(true);
    });

    it('flags non-English identifier in code block', () => {
      const r = validatePlanText({ plan: code('function salvarUsuario() {}') });
      expect(r.findings.some((f) => f.rule === 'NON_ENGLISH_IDENTIFIER')).toBe(true);
    });

    it('flags impl-before-approval marker', () => {
      const r = validatePlanText({
        plan: 'Plan draft.\n\nLet us start implementing now.\n\nUser feedback pending.',
      });
      expect(r.findings.some((f) => f.rule === 'IMPL_BEFORE_APPROVAL')).toBe(true);
    });
  });

  describe('golden negative — should NOT flag', () => {
    const negatives = [
      'Plan: add a new feature for export.',
      'Refactor the authentication module to reduce coupling.',
      'Run `git status` to inspect the current changes.',
      'The Portuguese word for user is usuário; here we keep identifiers English.',
      'Use Polly for retry. The HTTP client should observe a circuit breaker.',
      'Architecture: A -> B -> C; B is the only writer.',
      'Tests cover the happy path and edge cases.',
      '## Plan\n1. Add tool X\n2. Add tests\n3. Bump version',
      'Sequence: foundation first, then composers.',
      'Output format: JSON with severity_counts and agents_involved.',
      'Approved by user. ' + code('console.log("starting impl")'),
      'salva o usuário is Portuguese prose, not an identifier.',
      'No emojis here, just description.',
      'Schema: input.user_prompt: z.string().max(8192).',
      'Run `git diff --name-status HEAD~1..HEAD` for changed files.',
      'Ref pattern: ^[a-zA-Z0-9_/][a-zA-Z0-9_./-]*$',
      'Plan covers 3 tools: classify, detect, validate.',
      'Single-dev pre-1.0; defer property-based tests.',
      'Do not run git commit yourself — that is user-only.',
      'The tool returns findings: ValidationFinding[].',
    ];

    for (const text of negatives) {
      it(`negative: ${text.slice(0, 60)}...`, () => {
        const r = validatePlanText({ plan: text });
        expect(r.findings).toHaveLength(0);
      });
    }
  });

  it('completes within 100ms on 64KB input (no ReDoS)', () => {
    const big = 'plan content '.repeat(5000);
    const start = Date.now();
    validatePlanText({ plan: big });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(100);
  });
});
