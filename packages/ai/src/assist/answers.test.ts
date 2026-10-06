import { describe, expect, it } from 'vitest';
import {
  readArticleDraft,
  readClassification,
  readSummary,
  UnreadableAnswerError,
} from './answers.js';

const allowed = { tagIds: ['tag-refund', 'tag-vip'], departmentIds: ['dep-billing'] };

describe('readSummary', () => {
  it('reads the points out of a fenced answer and drops blank ones', () => {
    expect(readSummary('Sure:\n```json\n{"points": [" Mona wants a refund. ", ""]}\n```')).toEqual([
      'Mona wants a refund.',
    ]);
  });

  it('refuses an answer with no points', () => {
    expect(() => readSummary('{"points": []}')).toThrow(UnreadableAnswerError);
    expect(() => readSummary('I could not summarise this.')).toThrow(UnreadableAnswerError);
  });
});

describe('readClassification', () => {
  it('keeps only ids the brand has and a real priority', () => {
    expect(
      readClassification(
        '{"tagIds": ["tag-refund", "tag-invented", "tag-refund"], "priority": "high", "departmentId": "dep-billing"}',
        allowed,
      ),
    ).toEqual({ tagIds: ['tag-refund'], priority: 'high', departmentId: 'dep-billing' });
  });

  it('turns an unknown priority or department into no suggestion', () => {
    expect(
      readClassification('{"priority": "critical", "departmentId": "dep-sales"}', allowed),
    ).toEqual({ tagIds: [], priority: null, departmentId: null });
  });

  it('refuses something that is not an object', () => {
    expect(() => readClassification('{"tagIds": "refund"}', allowed)).toThrow(
      UnreadableAnswerError,
    );
  });
});

describe('readArticleDraft', () => {
  it('reads a title and a body', () => {
    expect(readArticleDraft('{"title": "Customs", "body": "Duty is paid on delivery."}')).toEqual({
      title: 'Customs',
      body: 'Duty is paid on delivery.',
    });
  });

  it('refuses a draft without a body', () => {
    expect(() => readArticleDraft('{"title": "Customs"}')).toThrow(UnreadableAnswerError);
    expect(() => readArticleDraft('{ not json }')).toThrow(UnreadableAnswerError);
  });
});
