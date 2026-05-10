import { describe, it, expect } from 'vitest';
import { applyConsolidationRules } from '../src/tools/consolidate.js';

describe('applyConsolidationRules — extended output', () => {
  it('emits severity_counts and agents_involved', () => {
    const r = applyConsolidationRules({
      reports: [
        {
          agent: 'product-owner',
          findings: [
            { severity: 'Major', title: 'a', justified: true },
            { severity: 'Minor', title: 'b' },
          ],
          not_evaluated: false,
        },
        {
          agent: 'senior-developer',
          findings: [{ severity: 'Suggestion', title: 'c' }],
          not_evaluated: false,
        },
      ],
    });
    expect(r.severity_counts).toEqual({ Blocker: 0, Major: 1, Minor: 1, Suggestion: 1 });
    expect(r.agents_involved).toEqual(['product-owner', 'senior-developer']);
  });

  it('agents_involved sorted deterministically', () => {
    const r = applyConsolidationRules({
      reports: [
        { agent: 'senior-qa', findings: [], not_evaluated: false },
        { agent: 'product-owner', findings: [], not_evaluated: false },
        { agent: 'senior-developer', findings: [], not_evaluated: false },
      ],
    });
    expect(r.agents_involved).toEqual(['product-owner', 'senior-developer', 'senior-qa']);
  });

  it('idempotent: same input -> same output', () => {
    const input = {
      reports: [
        {
          agent: 'product-owner' as const,
          findings: [{ severity: 'Major' as const, title: 'x', justified: true }],
          not_evaluated: false,
        },
      ],
    };
    const a = applyConsolidationRules(input);
    const b = applyConsolidationRules(input);
    expect(a).toEqual(b);
  });
});
