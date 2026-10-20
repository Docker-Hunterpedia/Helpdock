import { describe, expect, it } from 'vitest';
import { bestRank, fold, matchRank } from './fold.js';

describe('fold', () => {
  it('lowercases and collapses spaces', () => {
    expect(fold('  SLA   Policies ')).toBe('sla policies');
  });

  it('treats every alef form as a bare alef', () => {
    expect(fold('أحمد إبراهيم آمنة ٱلله')).toBe(fold('احمد ابراهيم امنه الله'));
  });

  it('treats alef maqsura as yaa and taa marbuta as haa', () => {
    expect(fold('مستوى')).toBe(fold('مستوي'));
    expect(fold('اتفاقية')).toBe(fold('اتفاقيه'));
  });

  it('drops diacritics and tatweel', () => {
    expect(fold('مَرْكَزُ')).toBe(fold('مركز'));
    expect(fold('الـــمركز')).toBe(fold('المركز'));
  });
});

describe('matchRank', () => {
  it('ranks a prefix above a word prefix above a contained match', () => {
    expect(matchRank('sla', 'SLA policies')).toBe(3);
    expect(matchRank('pol', 'SLA policies')).toBe(2);
    expect(matchRank('lic', 'SLA policies')).toBe(1);
  });

  it('needs every word, in any order', () => {
    expect(matchRank('policies sla', 'SLA policies')).toBeGreaterThan(0);
    expect(matchRank('sla billing', 'SLA policies')).toBe(0);
  });

  it('matches Arabic through the folds', () => {
    expect(matchRank('اتفاقيه مستوي', 'اتفاقية مستوى الخدمة')).toBeGreaterThan(0);
  });

  it('matches nothing for an empty query', () => {
    expect(matchRank('  ', 'anything')).toBe(0);
  });

  it('takes the best of several texts', () => {
    expect(bestRank('hours', ['Business hours', 'ساعات العمل'])).toBe(2);
    expect(bestRank('zzz', ['Business hours'])).toBe(0);
  });
});
