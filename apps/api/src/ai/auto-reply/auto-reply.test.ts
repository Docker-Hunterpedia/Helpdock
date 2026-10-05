import type { TicketMessage as TicketMessageRow } from '@helpdock/db';
import { aiAutoReplyJob } from '@helpdock/jobs';
import { ticketMessageAiSchema, widgetMessageSchema } from '@helpdock/schemas';
import type { Job } from 'bullmq';
import { describe, expect, it } from 'vitest';
import { toWidgetMessage } from '../../widget/widget-view.js';
import { aiMeta, readAiMeta, toTicketMessageAi, toWidgetMessageAi } from './ai-meta.js';
import { isAiPaused, toTicketAiState } from './ai-pause.js';
import { answerBody } from './answer-body.js';
import { type AutoReplyDeps, createAutoReplyProcessor } from './auto-reply.job.js';

const CHUNK = '0192c3f0-1a2b-7c3d-8e4f-000000000c01';
const INTERNAL = '0192c3f0-1a2b-7c3d-8e4f-000000000c02';
const ARTICLE = '0192c3f0-1a2b-7c3d-8e4f-000000000a01';
const AT = new Date('2026-10-05T09:12:00.000Z');

const citations = [
  {
    marker: 1,
    chunkId: CHUNK,
    title: 'Refund timelines',
    url: 'https://help.example.com/refunds',
    articleId: ARTICLE,
    visibility: 'public' as const,
  },
  {
    marker: 2,
    chunkId: INTERNAL,
    title: 'Ops handbook',
    url: null,
    articleId: null,
    visibility: 'internal' as const,
  },
];
const answer = aiMeta('answer', {
  answer: 'Card refunds take 3 to 5 days [1].',
  confidence: 0.86,
  threshold: 0.7,
  model: 'fake-model',
  citations,
});

const row = (overrides: Partial<TicketMessageRow> = {}): TicketMessageRow =>
  ({
    id: '0192c3f0-1a2b-7c3d-8e4f-000000000010',
    brandId: '0192c3f0-1a2b-7c3d-8e4f-0000000000b1',
    ticketId: '0192c3f0-1a2b-7c3d-8e4f-000000000001',
    departmentId: '0192c3f0-1a2b-7c3d-8e4f-0000000000d1',
    seq: 2,
    clientId: null,
    kind: 'ai',
    authorType: 'ai',
    authorId: 'ai:auto_reply',
    bodyHtml: '<p>Card refunds take 3 to 5 days [1].</p><p>Sources</p>',
    bodyText: 'Card refunds take 3 to 5 days [1].\n\nSources',
    channel: 'chat',
    externalMessageId: null,
    copiedFromMessageId: null,
    aiMeta: answer,
    email: null,
    createdAt: AT,
    ...overrides,
  }) as TicketMessageRow;

describe('ai_meta', () => {
  it('reads what auto-reply wrote and nothing another feature wrote', () => {
    expect(readAiMeta(answer)).toEqual(answer);
    expect(readAiMeta({ model: 'x', tokens: 3 })).toBeUndefined();
    expect(readAiMeta(null)).toBeUndefined();
  });

  it('shows staff every citation with its visibility, and the figures of the call', () => {
    const view = toTicketMessageAi(answer);

    expect(ticketMessageAiSchema.parse(view)).toEqual(view);
    expect(view?.citations.map((citation) => citation.visibility)).toEqual(['public', 'internal']);
    expect(view).toMatchObject({ confidence: 0.86, threshold: 0.7, model: 'fake-model' });
  });

  it('shows a visitor the public sources only, and never a score', () => {
    const view = toWidgetMessageAi(answer);

    expect(view).toEqual({
      kind: 'answer',
      citations: [
        {
          marker: 1,
          title: 'Refund timelines',
          url: 'https://help.example.com/refunds',
          articleId: ARTICLE,
        },
      ],
      feedback: null,
    });
    expect(JSON.stringify(view)).not.toContain('0.86');
  });

  it('gives a visitor no AI part for a pause event', () => {
    expect(toWidgetMessageAi(aiMeta('paused', { reason: 'staff_reply' }))).toBeUndefined();
  });

  it('puts the answer alone in the widget message, which draws its own sources', () => {
    const view = toWidgetMessage(row(), [], { staffNames: new Map(), showAgentIdentity: false });

    expect(widgetMessageSchema.parse(view)).toEqual(view);
    expect(view).toMatchObject({
      author: 'ai',
      text: 'Card refunds take 3 to 5 days [1].',
      html: null,
    });
  });
});

describe('answerBody', () => {
  it('lists the public sources under the answer for email and Telegram', () => {
    const body = answerBody('Card refunds take 3 to 5 days [1].', citations, 'en');

    expect(body.html).toContain('<a href="https://help.example.com/refunds"');
    expect(body.text).toContain('Sources');
    expect(body.text).toContain('[1] Refund timelines');
    expect(body.text).not.toContain('Ops handbook');
  });

  it('labels the list in the reader language', () => {
    expect(answerBody('x [1]', citations, 'ar').text).toContain('المصادر');
  });

  it('escapes what the model wrote rather than rendering it', () => {
    const body = answerBody('<img src=x onerror=alert(1)> Five days [1]', citations, 'en');

    expect(body.html).not.toContain('<img');
  });

  it('is the text alone when nothing public was cited', () => {
    expect(answerBody('A person will reply.', [], 'en')).toEqual({
      html: '<p>A person will reply.</p>',
      text: 'A person will reply.',
    });
  });
});

describe('the pause', () => {
  it('is on while set and not past its end', () => {
    expect(isAiPaused({ aiPausedAt: AT, aiPausedUntil: null }, AT)).toBe(true);
    expect(isAiPaused({ aiPausedAt: null, aiPausedUntil: null }, AT)).toBe(false);
    expect(isAiPaused({ aiPausedAt: AT, aiPausedUntil: new Date(AT.getTime() - 1) }, AT)).toBe(
      false,
    );
  });

  it('is shown with its reason, and without one once cleared', () => {
    expect(
      toTicketAiState({ aiPausedAt: AT, aiPausedUntil: null, aiPauseReason: 'customer_request' }),
    ).toEqual({ pausedAt: AT.toISOString(), pausedUntil: null, reason: 'customer_request' });
    expect(
      toTicketAiState({ aiPausedAt: null, aiPausedUntil: null, aiPauseReason: 'staff_reply' }),
    ).toEqual({ pausedAt: null, pausedUntil: null, reason: null });
  });
});

describe('the ai.auto_reply processor', () => {
  const processor = createAutoReplyProcessor({} as AutoReplyDeps);

  it('leaves another job on the queue to its own consumer', () => {
    expect(processor({ name: 'ai.assist', data: {} } as Job)).toBeNull();
  });

  it('refuses a payload it cannot read, without retrying it', () => {
    expect(() => processor({ name: aiAutoReplyJob.name, data: { brandId: 'x' } } as Job)).toThrow(
      /payload for job ai.auto_reply/,
    );
  });
});
