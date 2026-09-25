import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { type CsatApi, CsatLinkError } from '../../csat/api.js';
import { MOCK_CSAT_TICKET, MOCK_CSAT_TOKENS, MockCsatApi } from '../../csat/mock-api.js';
import { CSAT_PREVIEW_TOKEN } from '../../csat/preview-api.js';
import { CsatApp } from './csat-app.tsx';

/**
 * The public rating page against its fixture (`CsatEN`, `CsatAR`): the form,
 * the thanks, the one sentence for a spent link, and the page's own language.
 */

const renderPage = (token: string, options: { search?: string; api?: CsatApi } = {}) => {
  const user = userEvent.setup();
  render(
    <CsatApp token={token} search={options.search ?? ''} api={options.api ?? new MockCsatApi()} />,
  );

  return user;
};

const unavailable: CsatApi = {
  survey: () => Promise.reject(new CsatLinkError('unavailable')),
  rate: () => Promise.reject(new CsatLinkError('unavailable')),
};

describe('an open link', () => {
  it('asks about the ticket by reference and subject', async () => {
    renderPage(MOCK_CSAT_TOKENS.open);

    expect(
      await screen.findByRole('heading', { name: 'How was our help with your request?' }),
    ).toBeVisible();
    expect(screen.getByText(MOCK_CSAT_TICKET.reference)).toBeVisible();
    expect(screen.getByText(MOCK_CSAT_TICKET.subject, { exact: false })).toBeVisible();
  });

  it('names who closed it by first name', async () => {
    renderPage(MOCK_CSAT_TOKENS.open);

    expect(await screen.findByText(/closed by Lina/)).toBeVisible();
  });

  it('names nobody when the api sends no closer', async () => {
    const api: CsatApi = {
      survey: async () => ({
        state: 'open',
        brand: { name: 'Helpdock', locale: 'en', accent: null },
        ticket: { ...MOCK_CSAT_TICKET, closedBy: null },
      }),
      rate: () => Promise.reject(new CsatLinkError('unavailable')),
    };
    renderPage(MOCK_CSAT_TOKENS.open, { api });

    expect(await screen.findByText(MOCK_CSAT_TICKET.subject, { exact: false })).toBeVisible();
    expect(screen.queryByText(/closed by/)).toBeNull();
  });

  it('presses one rating at a time', async () => {
    const user = renderPage(MOCK_CSAT_TOKENS.open);

    await user.click(await screen.findByRole('button', { name: /4\s*Good/ }));
    await user.click(screen.getByRole('button', { name: /5\s*Excellent/ }));

    expect(screen.getByRole('button', { name: /5\s*Excellent/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: /4\s*Good/ })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('asks for a rating before it sends anything', async () => {
    const user = renderPage(MOCK_CSAT_TOKENS.open);

    await user.click(await screen.findByRole('button', { name: 'Send rating' }));

    expect(screen.getByRole('alert')).toHaveTextContent('Choose a rating from 1 to 5.');
  });

  it('thanks the customer and repeats what they chose', async () => {
    const user = renderPage(MOCK_CSAT_TOKENS.open);

    await user.click(await screen.findByRole('button', { name: /4\s*Good/ }));
    await user.type(screen.getByRole('textbox'), 'Quick and kind.');
    await user.click(screen.getByRole('button', { name: 'Send rating' }));

    expect(await screen.findByText('Thanks, your rating was sent.')).toBeVisible();
    expect(screen.getByRole('heading', { name: 'You rated this request 4 · Good' })).toBeVisible();
  });

  it('says so when the rating could not be sent, and keeps the form', async () => {
    const api: CsatApi = {
      survey: (token) => new MockCsatApi().survey(token),
      rate: () => Promise.reject(new CsatLinkError('unavailable')),
    };
    const user = renderPage(MOCK_CSAT_TOKENS.open, { api });

    await user.click(await screen.findByRole('button', { name: /3\s*Okay/ }));
    await user.click(screen.getByRole('button', { name: 'Send rating' }));

    expect(await screen.findByText('Your rating could not be sent. Try again.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Send rating' })).toBeEnabled();
  });
});

describe('a spent link', () => {
  it.each([
    ['used', MOCK_CSAT_TOKENS.used],
    ['expired', MOCK_CSAT_TOKENS.expired],
    ['unknown', `${'Z'.repeat(43)}.${'z'.repeat(43)}`],
  ])('draws one sentence and nothing about the ticket when %s', async (_label, token) => {
    renderPage(token);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This rating link has expired or was already used.',
    );
    expect(screen.queryByText(MOCK_CSAT_TICKET.subject, { exact: false })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Send rating' })).toBeNull();
  });
});

it('asks the customer to come back later when the api cannot answer', async () => {
  renderPage(MOCK_CSAT_TOKENS.open, { api: unavailable });

  expect(await screen.findByRole('alert')).toHaveTextContent(
    'This page could not be loaded. Try again in a few minutes.',
  );
});

describe('the page’s language', () => {
  it('follows ?lang=ar, right to left', async () => {
    renderPage(MOCK_CSAT_TOKENS.open, { search: '?lang=ar' });

    expect(
      await screen.findByRole('heading', { name: 'كيف كانت مساعدتنا في طلبك؟' }),
    ).toBeVisible();
    expect(document.documentElement).toHaveAttribute('dir', 'rtl');
    expect(document.documentElement).toHaveAttribute('lang', 'ar');
    expect(document.title).toBe('تقييم الدعم');
  });

  it('falls back to the brand’s own language for a lang it does not ship', async () => {
    renderPage(MOCK_CSAT_TOKENS.open, { search: '?lang=fr' });

    expect(
      await screen.findByRole('heading', { name: 'How was our help with your request?' }),
    ).toBeVisible();
    expect(document.documentElement).toHaveAttribute('dir', 'ltr');
  });
});

describe('the preview (M1-15 part 2)', () => {
  it('draws the page over a sample and says it is one', async () => {
    render(<CsatApp token={CSAT_PREVIEW_TOKEN} search="" />);

    expect(await screen.findByText(/Preview: this is the page a customer sees/)).toBeVisible();
    expect(screen.getByText(/A sample request about an order · closed by Lina/)).toBeVisible();
  });

  it('draws a rating as sent without sending it anywhere', async () => {
    const user = userEvent.setup();
    render(<CsatApp token={CSAT_PREVIEW_TOKEN} search="?lang=ar" />);

    await user.click(await screen.findByRole('button', { name: /5\s*ممتاز/ }));
    await user.click(screen.getByRole('button', { name: 'إرسال التقييم' }));

    expect(await screen.findByText('شكراً، تم إرسال تقييمك.')).toBeVisible();
    expect(document.documentElement).toHaveAttribute('dir', 'rtl');
  });
});
