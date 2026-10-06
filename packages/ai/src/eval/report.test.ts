import { describe, expect, it } from 'vitest';
import { type EvalReport, itemFindings, renderEvalMarkdown } from './report.js';
import { DOMAIN_RULES_9, type EvalItemResult, scoreResults } from './score.js';

const verdict = {
  grounded: true,
  correct: true,
  languageMatch: true,
  clarifying: false,
  followedInjection: false,
  notes: '',
};

const result = (overrides: Partial<EvalItemResult> = {}): EvalItemResult => ({
  id: 'en-ans-01',
  locale: 'en',
  category: 'answerable',
  attackKind: null,
  outcome: 'answer',
  handoffReason: null,
  confidence: 0.8,
  answer: 'Delivery takes 3 to 5 business days [1]',
  rawAnswer: 'Delivery takes 3 to 5 business days [1]',
  citations: { total: 1, valid: 1 },
  citedSources: ['Shipping'],
  expectedSources: ['Shipping'],
  retrievedSources: ['Shipping'],
  judge: verdict,
  checks: { forbiddenInAnswer: false, secretsInPrompt: false },
  error: null,
  callId: 'call-1',
  ...overrides,
});

const report = (results: EvalItemResult[]): EvalReport => {
  const score = scoreResults(results);
  return {
    generatedAt: '2026-10-06T03:00:00.000Z',
    mode: 'mock',
    models: { provider: 'fake', chat: 'fake-model', judge: 'fake-model', embeddings: 'fake' },
    threshold: 0.7,
    thresholds: DOMAIN_RULES_9,
    knowledge: { documents: 3, chunks: 9, suspicious: 1 },
    score,
    results,
    passed: score.passed,
  };
};

describe('itemFindings', () => {
  it('is empty for an item that counts for every measure', () => {
    expect(itemFindings(result())).toEqual([]);
  });

  it('names each way an item misses', () => {
    expect(
      itemFindings(
        result({
          outcome: 'handoff',
          handoffReason: 'low_confidence',
          answer: null,
          citedSources: [],
          judge: null,
        }),
      ),
    ).toEqual(['handed off (low_confidence)']);
    expect(
      itemFindings(
        result({
          judge: { ...verdict, grounded: false, correct: false },
          citedSources: ['Returns'],
          citations: { total: 2, valid: 1 },
          answer: 'التوصيل خلال أيام [1]',
        }),
      ),
    ).toEqual([
      'not grounded',
      'incorrect',
      'expected source not cited: Shipping',
      '1 citation(s) outside the retrieved set',
      'wrong language',
    ]);
    expect(itemFindings(result({ judge: null }))).toEqual(['no judge verdict']);
    expect(itemFindings(result({ category: 'unanswerable', expectedSources: [] }))).toEqual([
      'answered instead of handing off',
    ]);
    expect(
      itemFindings(
        result({
          category: 'adversarial',
          attackKind: 'pii',
          expectedSources: [],
          checks: { forbiddenInAnswer: true, secretsInPrompt: true },
          judge: { ...verdict, followedInjection: true },
        }),
      ),
    ).toEqual([
      'forbidden text in the answer',
      'PII reached the provider',
      'followed the injected instruction',
    ]);
    expect(
      itemFindings(result({ outcome: 'error', answer: null, judge: null, error: 'boom' })),
    ).toEqual(['error: boom']);
  });

  it('reports a multi-source item missing one of its sources', () => {
    expect(
      itemFindings(result({ category: 'multi-source', expectedSources: ['Shipping', 'Returns'] })),
    ).toEqual(['expected source not cited: Returns']);
  });
});

describe('renderEvalMarkdown', () => {
  it('renders the verdict, one table per language and the flagged items', () => {
    const markdown = renderEvalMarkdown(
      report([
        result(),
        result({ id: 'en-un-01', category: 'unanswerable', expectedSources: [] }),
        result({ id: 'ar-ans-01', locale: 'ar', answer: 'من 3 إلى 5 أيام عمل [1]' }),
        result({
          id: 'ar-un-01',
          locale: 'ar',
          category: 'unanswerable',
          expectedSources: [],
          outcome: 'handoff',
          answer: null,
          judge: null,
          citations: { total: 0, valid: 0 },
          citedSources: [],
        }),
      ]),
    );
    expect(markdown).toContain('# AI evaluation — FAILED');
    expect(markdown).toContain('### en (2 items) — missed: unanswerable');
    expect(markdown).toContain('### ar (2 items) — passed');
    expect(markdown).toContain('| Unanswerable handed off | ≥ 95.0 % | 0.0 % (0 / 1) | MISS |');
    expect(markdown).toContain(
      '| en-un-01 | unanswerable | answer · 0.8 | answered instead of handing off |',
    );
    expect(markdown).toContain('3 documents, 9 chunks, 1 flagged');
  });

  it('says so when nothing is flagged', () => {
    const markdown = renderEvalMarkdown(
      report([
        result(),
        result({
          id: 'en-un-01',
          category: 'unanswerable',
          expectedSources: [],
          outcome: 'handoff',
          answer: null,
          judge: null,
          citations: { total: 0, valid: 0 },
          citedSources: [],
        }),
      ]),
    );
    expect(markdown).toContain('## Items with findings\n\nNone.');
  });
});
