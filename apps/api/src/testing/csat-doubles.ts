import type { CsatResponse } from '@helpdock/db';
import type { CsatDelivery } from '../csat/csat-delivery.js';
import type { CsatTelegramNotices } from '../csat/telegram-csat.js';
import type { SurveyEmailSource } from '../email/email-send.job.js';

/**
 * M8-06's survey seams, doing nothing, for suites about something else: a
 * close there still creates its survey, and nothing is sent for it.
 * `csat/delivery.integration.test.ts` runs the real ones.
 */

export const noCsatDelivery: Pick<CsatDelivery, 'deliver'> = {
  deliver: () => Promise.resolve('unreachable'),
};

export const noSurveyEmails: SurveyEmailSource = {
  forDelivery: () => Promise.resolve(undefined),
  markSent: () => Promise.resolve(),
};

export const noCsatNotices: Pick<CsatTelegramNotices, 'send'> = {
  send: () => Promise.resolve(),
};

export const CSAT_BRAND = '0199f4b2-0000-7000-8000-0000000000b1';
export const CSAT_TICKET = '0199f4b2-2222-7000-8000-0000000000aa';
export const CSAT_SURVEY = '0199f4b2-4444-7000-8000-0000000000cc';
export const CSAT_NOW = new Date('2026-10-05T10:00:00.000Z');

/** An unanswered survey, closed at {@link CSAT_NOW}, open for thirty days. */
export const csatSurveyRow = (overrides: Partial<CsatResponse> = {}): CsatResponse => ({
  id: CSAT_SURVEY,
  brandId: CSAT_BRAND,
  ticketId: CSAT_TICKET,
  departmentId: '0199f4b2-3333-7000-8000-0000000000dd',
  closedAt: CSAT_NOW,
  tokenHash: 'not-a-real-hash',
  expiresAt: new Date(CSAT_NOW.getTime() + 30 * 86_400_000),
  sentAt: null,
  rating: null,
  comment: null,
  ratedAt: null,
  ratedVia: null,
  skippedAt: null,
  createdAt: CSAT_NOW,
  ...overrides,
});
