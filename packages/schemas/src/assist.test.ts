import { describe, expect, it } from 'vitest';
import {
  proposalCreateRequestSchema,
  proposalListQuerySchema,
  translateRequestSchema,
} from './assist.js';
import { actionOutcomeSchema, ruleActionSchema } from './workflow-rules.js';

const id = '0192f3a0-0000-7000-8000-000000000001';

describe('translateRequestSchema', () => {
  it('takes exactly one of a message, a transcript and a draft', () => {
    expect(translateRequestSchema.safeParse({ messageId: id, target: 'ar' }).success).toBe(true);
    expect(translateRequestSchema.safeParse({ attachmentId: id, target: 'en' }).success).toBe(true);
    expect(translateRequestSchema.safeParse({ text: 'Hello', target: 'ar' }).success).toBe(true);
    expect(translateRequestSchema.safeParse({ target: 'ar' }).success).toBe(false);
    expect(
      translateRequestSchema.safeParse({ messageId: id, text: 'Hello', target: 'ar' }).success,
    ).toBe(false);
  });
});

describe('proposals', () => {
  it('lists waiting proposals unless asked for decided ones', () => {
    expect(proposalListQuerySchema.parse({})).toEqual({ status: 'waiting' });
  });

  it('refuses a draft without a title', () => {
    expect(
      proposalCreateRequestSchema.safeParse({
        sectionId: null,
        locale: 'en',
        title: ' ',
        bodyMarkdown: 'Body',
        note: null,
        callId: null,
        messageCount: 1,
        citations: [],
      }).success,
    ).toBe(false);
  });
});

describe('the AI triage action (M7-07)', () => {
  it('names a mode and at least one field, each once', () => {
    expect(
      ruleActionSchema.safeParse({ type: 'ai_triage', mode: 'apply', fields: ['tags'] }).success,
    ).toBe(true);
    expect(
      ruleActionSchema.safeParse({ type: 'ai_triage', mode: 'apply', fields: [] }).success,
    ).toBe(false);
    expect(
      ruleActionSchema.safeParse({ type: 'ai_triage', mode: 'suggest', fields: ['tags', 'tags'] })
        .success,
    ).toBe(false);
  });

  it('carries its outcome in the run log', () => {
    expect(
      actionOutcomeSchema.parse({
        action: { type: 'ai_triage', mode: 'suggest', fields: ['priority'] },
        effect: 'changed',
        triage: { status: 'suggested', priority: 'high' },
      }).triage,
    ).toEqual({ status: 'suggested', priority: 'high' });
  });
});
