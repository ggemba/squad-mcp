import { describe, it, expect } from 'vitest';
import { applyConsolidationRules } from '../src/tools/consolidate.js';

describe('applyConsolidationRules', () => {
  it('REJECTED on any blocker', () => {
    const r = applyConsolidationRules({
      reports: [
        { agent: 'senior-dba', findings: [{ severity: 'Blocker', title: 'data loss path' }], not_evaluated: false },
      ],
    });
    expect(r.verdict).toBe('REJECTED');
    expect(r.blockers).toHaveLength(1);
  });

  it('REJECTED on unjustified Major', () => {
    const r = applyConsolidationRules({
      reports: [
        {
          agent: 'senior-dev-security',
          findings: [{ severity: 'Major', title: 'missing authz', justified: false }],
          not_evaluated: false,
        },
      ],
    });
    expect(r.verdict).toBe('REJECTED');
  });

  it('CHANGES_REQUIRED on Minor only', () => {
    const r = applyConsolidationRules({
      reports: [
        { agent: 'senior-dev-reviewer', findings: [{ severity: 'Minor', title: 'naming' }], not_evaluated: false },
      ],
    });
    expect(r.verdict).toBe('CHANGES_REQUIRED');
  });

  it('APPROVED when no findings', () => {
    const r = applyConsolidationRules({
      reports: [{ agent: 'po', findings: [], not_evaluated: false }],
    });
    expect(r.verdict).toBe('APPROVED');
  });

  it('records not_evaluated agents', () => {
    const r = applyConsolidationRules({
      reports: [{ agent: 'senior-qa', findings: [], not_evaluated: true }],
    });
    expect(r.not_evaluated).toContain('senior-qa');
  });
});
