import type { TicketAiState } from '@helpdock/schemas';
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderApp } from '../../test/render.tsx';
import { NOW, testTicket } from '../../tickets/fixtures.js';
import { TicketRow } from './ticket-row.tsx';

/**
 * What the ticket list says about the assistant on a row (M7-06,
 * `Admin/Ticket-AI`): "AI paused" while the conversation is handed off, "AI
 * answered" once the assistant took part and was not paused, nothing when it
 * never did.
 */

const PAUSED: TicketAiState = {
  pausedAt: '2026-10-05T09:18:00.000Z',
  pausedUntil: null,
  reason: 'low_confidence',
};
const ANSWERED: TicketAiState = { pausedAt: null, pausedUntil: null, reason: null };
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

describe('the assistant on a ticket row', () => {
  it.each([
    ['a handed-off conversation is marked "AI paused", not answered', PAUSED, ['AI paused']],
    [
      'a conversation the assistant answered and still holds is marked "AI answered"',
      ANSWERED,
      ['AI answered'],
    ],
    ['a ticket the assistant never took part in says nothing', undefined, []],
  ])('%s', (_scenario, ai, expected) => {
    expect(captionsOnRow(ai)).toEqual(expected);
  });
});
