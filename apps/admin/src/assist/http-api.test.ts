import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpTransport } from '../auth/http-transport.js';
import { HttpAssistApi } from './http-api.js';

/**
 * The adapter against a stubbed `fetch`, through the real `HttpTransport`: what
 * it sends, and that it parses what comes back. The transport owns the `/api`
 * prefix, so a path that repeats it reaches `/api/api/…`, which the api answers
 * with 404 and the composer reads as "agent assist is off" (#174: every
 * production build shipped without the Assist menu).
 */

const BRAND = '0192c3f0-1a2b-7c3d-8e4f-000000000001';
const TICKET = '0192c3f0-1a2b-7c3d-8e4f-000000001042';
const PROPOSAL = '0192c3f0-1a2b-7c3d-8e4f-000000000777';
const SECTION = '0192c3f0-1a2b-7c3d-8e4f-000000000888';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let fetchMock: ReturnType<typeof vi.fn>;
let api: HttpAssistApi;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  api = new HttpAssistApi(new HttpTransport());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const lastUrl = (): string => String(fetchMock.mock.calls.at(-1)?.[0]);

describe('HttpAssistApi', () => {
  it('reads a ticket’s assist state from the route the api serves', async () => {
    fetchMock.mockResolvedValue(
      json({
        enabled: true,
        blocked: null,
        budget: [],
        keepAssistAfterHardStop: true,
        ticketClosed: false,
        proposal: null,
        suggestions: null,
      }),
    );

    const state = await api.state(BRAND, TICKET);

    expect(lastUrl()).toBe(`/api/brands/${BRAND}/tickets/${TICKET}/assist`);
    expect(state.enabled).toBe(true);
  });

  const ticketRoute = `/api/brands/${BRAND}/tickets/${TICKET}`;
  const proposalsRoute = `/api/brands/${BRAND}/help-center/proposals`;

  it.each([
    ['suggestReply', () => api.suggestReply(BRAND, TICKET), `${ticketRoute}/assist/suggest-reply`],
    ['summarize', () => api.summarize(BRAND, TICKET, 'en'), `${ticketRoute}/assist/summarize`],
    [
      'suggestFields',
      () => api.suggestFields(BRAND, TICKET),
      `${ticketRoute}/assist/suggest-fields`,
    ],
    [
      'dismissSuggestion',
      () => api.dismissSuggestion(BRAND, TICKET, { field: 'priority' }),
      `${ticketRoute}/assist/suggestions/dismiss`,
    ],
    [
      'translate',
      () => api.translate(BRAND, TICKET, { text: 'Hello', target: 'ar' }),
      `${ticketRoute}/assist/translate`,
    ],
    [
      'rewrite',
      () => api.rewrite(BRAND, TICKET, { text: 'Hello', tone: 'friendlier' }),
      `${ticketRoute}/assist/rewrite`,
    ],
    [
      'draftArticle',
      () => api.draftArticle(BRAND, TICKET, 'en'),
      `${ticketRoute}/assist/draft-article`,
    ],
    [
      'propose',
      () =>
        api.propose(BRAND, TICKET, {
          sectionId: null,
          locale: 'en',
          title: 'Resetting your password',
          bodyMarkdown: 'Open the sign-in page.',
          note: null,
          callId: null,
          messageCount: 2,
          citations: [],
        }),
      `${ticketRoute}/assist/proposals`,
    ],
    ['redactions', () => api.redactions(BRAND, TICKET), `${ticketRoute}/ai/redactions`],
    ['transcripts', () => api.transcripts(BRAND, TICKET), `${ticketRoute}/transcripts`],
    [
      'proposals',
      () => api.proposals(BRAND, { status: 'waiting' }),
      `${proposalsRoute}?status=waiting`,
    ],
    ['proposal', () => api.proposal(BRAND, PROPOSAL), `${proposalsRoute}/${PROPOSAL}`],
    [
      'approve',
      () =>
        api.approve(BRAND, PROPOSAL, { sectionId: SECTION, locale: 'en', visibility: 'public' }),
      `${proposalsRoute}/${PROPOSAL}/approve`,
    ],
    [
      'reject',
      () => api.reject(BRAND, PROPOSAL, 'Duplicate'),
      `${proposalsRoute}/${PROPOSAL}/reject`,
    ],
  ] as const)('%s calls its route under a single /api prefix', async (_name, send, url) => {
    // Only the address is under test here; what each answer parses to is the
    // api's schema, so an empty body that fails to parse is fine.
    fetchMock.mockResolvedValue(json({}));

    await send().catch(() => undefined);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lastUrl()).toBe(url);
  });
});
