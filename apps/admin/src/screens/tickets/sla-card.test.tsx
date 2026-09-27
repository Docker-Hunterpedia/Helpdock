import type { TicketSla, TicketSlaClock } from '@helpdock/schemas';
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderApp } from '../../test/render.tsx';
import { testTicket } from '../../tickets/fixtures.js';
import { SlaCard } from './sla-card.tsx';

/**
 * Every state of the DetailsPanel SLA card (`Admin/Ticket-SLA`, M3-02):
 * running, warning, paused, breached, met, reopened and no policy.
 */

const NOW = Date.parse('2026-10-04T08:40:00.000Z');
const MINUTE = 60_000;

const clock = (overrides: Partial<TicketSlaClock> = {}): TicketSlaClock => ({
  kind: 'first_response',
  targetMinutes: 120,
  startedAt: '2026-10-04T06:00:00.000Z',
  dueAt: '2026-10-04T10:00:00.000Z',
  satisfiedAt: null,
  breachedAt: null,
  pausedAt: null,
  stoppedAt: null,
  elapsedMs: 40 * MINUTE,
  firedSteps: [],
  ...overrides,
});

const sla = (overrides: Partial<TicketSla> = {}): TicketSla => ({
  state: 'running',
  policyId: '0192c3f0-1a2b-7c3d-8e4f-0000000005a1',
  policyName: 'Billing and Returns',
  timeMode: 'business',
  clocks: [clock(), clock({ kind: 'resolution', targetMinutes: 480, elapsedMs: 80 * MINUTE })],
  lastStep: null,
  reopenedAt: null,
  initialResponse: null,
  ...overrides,
});

const renderCard = (
  value: TicketSla | null,
  closedAt: string | null = null,
  canConfigure = false,
) =>
  renderApp(
    <SlaCard
      ticket={testTicket({ closedAt })}
      sla={value}
      statusLabel="Awaiting customer"
      departmentName="Sales"
      now={NOW}
      canConfigure={canConfigure}
    />,
  );

describe('SlaCard', () => {
  it('runs: time left per clock and a bar for the clock due first', () => {
    renderCard(sla());

    expect(screen.getByRole('heading', { name: 'SLA · Billing and Returns' })).toBeVisible();
    expect(screen.getByText('1h 20m left')).toBeVisible();
    expect(screen.getByText('6h 40m left')).toBeVisible();
    expect(screen.getByRole('progressbar', { name: 'First response time used' })).toHaveAttribute(
      'aria-valuenow',
      '33',
    );
  });

  it('warns with the step that ran', () => {
    renderCard(
      sla({
        state: 'warning',
        lastStep: {
          clock: 'first_response',
          percent: 75,
          firedAt: '2026-10-04T08:30:00.000Z',
          actions: [{ type: 'notify', recipient: { kind: 'department_leads' } }],
        },
      }),
    );

    expect(screen.getByText(/75 % step ran .* · team leads notified/)).toBeVisible();
  });

  it('pauses with no due time and says since when', () => {
    renderCard(
      sla({
        state: 'paused',
        clocks: [
          clock({ satisfiedAt: '2026-10-04T07:30:00.000Z', elapsedMs: 90 * MINUTE }),
          clock({
            kind: 'resolution',
            targetMinutes: 480,
            elapsedMs: 90 * MINUTE,
            dueAt: null,
            pausedAt: '2026-10-04T07:30:00.000Z',
          }),
        ],
      }),
    );

    expect(screen.getByText('met in 1h 30m')).toBeVisible();
    expect(screen.getByText('6h 30m left')).toBeVisible();
    expect(screen.getByText('paused, no due time')).toBeVisible();
    expect(screen.getByText(/Paused since .* · Awaiting customer/)).toBeVisible();
  });

  it('breaches, once per clock, and names the escalation', () => {
    renderCard(
      sla({
        state: 'breached',
        clocks: [clock({ breachedAt: '2026-10-04T06:36:00.000Z', elapsedMs: 130 * MINUTE })],
        lastStep: {
          clock: 'first_response',
          percent: 100,
          firedAt: '2026-10-04T06:36:00.000Z',
          actions: [{ type: 'set_escalated' }],
        },
      }),
    );

    expect(screen.getByText('breached 2h 04m')).toBeVisible();
    expect(screen.getByText(/was due/)).toBeVisible();
    expect(screen.getByText('Escalated at 100 %')).toBeVisible();
  });

  it('is met and closed, or reopened with the initial result kept', () => {
    const { unmount } = renderCard(
      sla({
        state: 'met',
        clocks: [
          clock({ satisfiedAt: '2026-10-04T07:30:00.000Z', elapsedMs: 90 * MINUTE }),
          clock({
            kind: 'resolution',
            satisfiedAt: '2026-10-04T08:00:00.000Z',
            elapsedMs: 460 * MINUTE,
          }),
        ],
      }),
      '2026-10-04T08:00:00.000Z',
    );
    expect(screen.getByText('met in 7h 40m')).toBeVisible();
    expect(screen.getByText(/^Closed /)).toBeVisible();
    unmount();

    renderCard(
      sla({
        clocks: [clock({ kind: 'next_response', elapsedMs: 0 })],
        reopenedAt: '2026-10-04T08:00:00.000Z',
        initialResponse: 'met',
      }),
    );
    expect(screen.getByText('Next response')).toBeVisible();
    expect(screen.getByText(/Reopened .* · initial response met/)).toBeVisible();
  });

  it('says no policy applies, and links to the policies for somebody who can change them', () => {
    const { unmount } = renderCard(null, null, true);

    expect(screen.getByText('No SLA policy applies')).toBeVisible();
    expect(screen.getByText(/No policy matches Sales at Medium priority/)).toBeVisible();
    expect(screen.getByRole('link', { name: 'SLA policies' })).toBeVisible();
    unmount();

    renderCard(null);
    expect(screen.queryByRole('link', { name: 'SLA policies' })).toBeNull();
  });
});
