import { describe, expect, it } from 'vitest';
import {
  classifyInstructions,
  draftArticleInstructions,
  formatKnowledge,
  formatThread,
  rewriteInstructions,
  suggestReplyInstructions,
  summarizeInstructions,
  translateInstructions,
} from './prompts.js';

describe('formatThread', () => {
  it('labels each message by who wrote it, oldest first', () => {
    expect(
      formatThread([
        { role: 'customer', text: ' Where is my refund? ' },
        { role: 'note', text: 'Checked: issued on the 4th.' },
        { role: 'assistant', text: 'It takes five days.' },
        { role: 'agent', text: 'It is on its way.' },
      ]),
    ).toBe(
      'Customer:\nWhere is my refund?\n\nInternal note:\nChecked: issued on the 4th.\n\nAssistant:\nIt takes five days.\n\nAgent:\nIt is on its way.',
    );
  });
});

describe('formatKnowledge', () => {
  it('numbers excerpts as the model must cite them', () => {
    expect(formatKnowledge([{ index: 1, title: 'Refunds', content: 'Five days. ' }])).toBe(
      'Knowledge:\n[1] Refunds\nFive days.',
    );
  });

  it('says so when nothing was found', () => {
    expect(formatKnowledge([])).toContain('none was found');
  });
});

describe('the task instructions', () => {
  it('ask for the reply in the customer’s language with citations', () => {
    const text = suggestReplyInstructions('ar');
    expect(text).toContain('Arabic');
    expect(text).toContain('[1]');
    expect(text).toContain('[EMAIL_1]');
  });

  it('offer only the brand’s own tags and departments, and only the fields asked for', () => {
    const text = classifyInstructions({
      tags: [{ id: 'tag-1', name: 'refund' }],
      departments: [{ id: 'dep-1', name: 'Billing' }],
      fields: ['tags', 'department'],
    });
    expect(text).toContain('- tag-1: refund');
    expect(text).toContain('- dep-1: Billing');
    expect(text).not.toContain('"priority"');
    expect(classifyInstructions({ tags: [], departments: [], fields: ['tags'] })).toContain(
      'the brand has no tags',
    );
    expect(classifyInstructions({ tags: [], departments: [], fields: ['priority'] })).toContain(
      '"urgent"',
    );
  });

  it('name the language, tone and shape each task answers in', () => {
    expect(summarizeInstructions('en')).toContain('{"points"');
    expect(translateInstructions('en')).toContain('into English');
    expect(rewriteInstructions('shorter')).toContain('shorter');
    expect(rewriteInstructions('friendlier')).toContain('friendlier');
    expect(rewriteInstructions('formal')).toContain('formal');
    expect(draftArticleInstructions('en')).toContain('"title"');
  });
});
