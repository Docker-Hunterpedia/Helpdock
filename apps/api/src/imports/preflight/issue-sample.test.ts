import { describe, expect, it } from 'vitest';
import { sampleImportIssues } from './issue-sample.js';

describe('bounded import issue samples', () => {
  it('retains late retention warnings across checkpoint pages without mutating earlier samples', () => {
    const earlier = Array.from({ length: 100 }, (_, index) => ({
      code: 'phone-refused',
      externalId: `${index}`,
    }));
    const retention = { code: 'retention-closed-history', externalId: 'old-ticket' };
    const sample = sampleImportIssues([...earlier, retention], 100);
    expect(sample[0]).toEqual(retention);
    expect(sample.slice(1)).toEqual(earlier.slice(0, 99));
    expect(earlier[0]?.externalId).toBe('0');
    expect(sample).toHaveLength(100);
  });
});
