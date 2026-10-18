import type { TicketCsat } from '@helpdock/schemas';
import { screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { LOCALE_STORAGE_KEY } from '../../app/preferences.js';
import { renderApp } from '../../test/render.js';
import { CsatCard } from './csat-card.js';

it.each(['en', 'ar'] as const)(
  'shows an unscored historical answer without a zero score or survey link in %s',
  (locale) => {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    const csat: TicketCsat = {
      state: 'imported_unscored',
      rating: null,
      comment: null,
      link: null,
      expiresAt: '1970-01-01T00:00:00Z',
      ratedAt: '2020-01-01T00:00:00Z',
      originalAnswers: [
        { question_id: 'Q1', question_text: 'Original source question', value: 7 },
        { question_id: 'Q2', question_text: 'Reasons', value: ['first', 'second'] },
        { question_id: 'Q3', question_text: 'Feedback', value: '<script>source text</script>' },
      ],
    };
    const { container } = renderApp(<CsatCard csat={csat} onCopy={vi.fn()} />);
    expect(
      screen.getByText(
        locale === 'en'
          ? 'Imported answer · score not mapped'
          : 'إجابة مستوردة · التقييم غير مطابق للمقياس',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('Original source question')).toBeInTheDocument();
    expect(screen.getByText('first, second')).toBeInTheDocument();
    expect(screen.getByText('<script>source text</script>')).toBeInTheDocument();
    expect(container.querySelector('script')).toBeNull();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByText(/Rated 0/)).not.toBeInTheDocument();
  },
);
