import type { TicketAiState } from '@helpdock/schemas';
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderApp } from '../../test/render.tsx';
import { NOW, testTicket } from '../../tickets/fixtures.js';
import { TicketRow } from './ticket-row.tsx';

/**
 * What the ticket list says about the assistant on a row (M7-06,
 * `Admin/Ticket-AI`): "AI paused" while the conversation is handed off, "AI
 * answered" once the assistant sent an answer and is not paused, nothing when
 * it never answered.
 */

const AT = '2026-10-05T09:18:00.000Z';
const HANDED_BACK: TicketAiState = {
  pausedAt: null,
  pausedUntil: null,
  reason: null,
  answeredAt: null,
};
const ANSWERED: TicketAiState = { ...HANDED_BACK, answeredAt: AT };
const PAUSED: TicketAiState = { ...HANDED_BACK, pausedAt: AT, reason: 'low_confidence' };
const CAPTIONS = ['AI paused', 'AI answered'];

const captionsOnRow = (ai: TicketAiState | undefined): string[] => {
  renderApp(
    <ul>
      <TicketRow
        ticket={testTicket({ ...(ai === undefined ? {} : { ai }) })}
        selected={false}
        now={NOW}
        search=""
      />
    </ul>,
  );

  return CAPTIONS.filter((caption) => screen.queryByText(caption) !== null);
};

describe('the subject on a ticket row', () => {
  it('takes its own direction, so an English subject in the Arabic admin keeps its punctuation', () => {
    renderApp(
      <ul>
        <TicketRow
          ticket={testTicket({ subject: 'Do you ship to Ireland?' })}
          selected={false}
          now={NOW}
          search=""
        />
      </ul>,
    );

    expect(screen.getByText('Do you ship to Ireland?')).toHaveAttribute('dir', 'auto');
  });
});

describe('the assistant on a ticket row', () => {
  it.each([
    ['a handed-off conversation is marked "AI paused", not answered', PAUSED, ['AI paused']],
    [
      'a conversation the assistant answered and still holds is marked "AI answered"',
      ANSWERED,
      ['AI answered'],
    ],
    [
      'a conversation answered and then handed off is marked "AI paused" alone',
      { ...PAUSED, answeredAt: AT },
      ['AI paused'],
    ],
    [
      'a conversation handed back to the assistant before it ever answered says nothing',
      HANDED_BACK,
      [],
    ],
    ['a ticket the assistant never took part in says nothing', undefined, []],
  ])('%s', (_scenario, ai, expected) => {
    expect(captionsOnRow(ai)).toEqual(expected);
  });
});
