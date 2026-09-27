import { describe, expect, it } from 'vitest';
import type { WebFormSubmission } from './submission.js';
import { messageHtml, subjectFor, submissionExternalId } from './web-form-ticket.writer.js';

const submission = (overrides: Partial<WebFormSubmission>): WebFormSubmission => ({
  name: null,
  email: 'a@example.com',
  subject: null,
  message: 'Hi',
  custom: {},
  files: [],
  ...overrides,
});

describe('subjectFor', () => {
  it('uses the subject the customer typed', () => {
    expect(subjectFor(submission({ subject: 'Refund' }), 'en')).toBe('Refund');
  });

  it('falls back to the first line of the message, shortened', () => {
    expect(subjectFor(submission({ message: '\n  Where is my order?\nMore' }), 'en')).toBe(
      'Where is my order?',
    );
    const long = subjectFor(submission({ message: 'x'.repeat(200) }), 'en');
    expect(long).toHaveLength(80);
    expect(long.endsWith('…')).toBe(true);
  });

  it('says "no subject" in the page language when there is nothing to take', () => {
    expect(subjectFor(submission({ message: '   ' }), 'en')).toBe('(no subject)');
    expect(subjectFor(submission({ message: '' }), 'ar')).not.toBe('(no subject)');
  });
});

describe('messageHtml', () => {
  it('escapes the text and keeps its paragraphs and line breaks', () => {
    expect(messageHtml('Hello <b>team</b>\nline two\n\n  second & last  ')).toBe(
      '<p>Hello &lt;b&gt;team&lt;/b&gt;<br>line two</p><p>second &amp; last</p>',
    );
  });
});

describe('submissionExternalId', () => {
  it('namespaces the submission id for the message dedupe index', () => {
    expect(submissionExternalId('abc')).toBe('webform:abc');
  });
});
