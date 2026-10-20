import { SNOOZE_MAX_MS, SNOOZE_MIN_MS } from '@helpdock/schemas';
import { screen, within } from '@testing-library/react';
import { type ReactNode, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderApp } from '../../../test/render.tsx';
import { MOCK_TICKET_REFUND, MockTicketsApi } from '../../../tickets/mock-api.js';
import { SnoozeControl } from './snooze-control.tsx';
import { pickProblem, SnoozePickerDialog } from './snooze-picker-dialog.tsx';
import { SnoozedStrip } from './snoozed-strip.tsx';

const BRAND = '0192c3f0-1a2b-7c3d-8e4f-0000000000b1';
const NOW = Date.UTC(2026, 9, 21, 12, 0, 0);

describe('pickProblem', () => {
  it('accepts a time between five minutes and ninety days ahead', () => {
    expect(pickProblem(new Date(NOW + SNOOZE_MIN_MS + 60_000).toISOString(), NOW)).toBeNull();
    expect(pickProblem(new Date(NOW + SNOOZE_MAX_MS - 60_000).toISOString(), NOW)).toBeNull();
  });

  it('names the problem with a time that is too soon, too far, or not a time', () => {
    expect(pickProblem(new Date(NOW + 60_000).toISOString(), NOW)).toBe('tooSoon');
    expect(pickProblem(new Date(NOW - 3_600_000).toISOString(), NOW)).toBe('tooSoon');
    expect(pickProblem(new Date(NOW + SNOOZE_MAX_MS + 60_000).toISOString(), NOW)).toBe('tooFar');
    expect(pickProblem('', NOW)).toBe('invalid');
    expect(pickProblem('not a time', NOW)).toBe('invalid');
  });
});

describe('SnoozedStrip', () => {
  it('names who snoozed it, until when and what wakes it early, as one status', async () => {
    const onWake = vi.fn();
    const { user } = renderApp(
      <SnoozedStrip by="Lina" until="Sun 25 Oct, 09:00" canWake busy={false} onWake={onWake} />,
    );

    const strip = screen.getByRole('status');
    expect(strip).toHaveTextContent('Snoozed by Lina until Sun 25 Oct, 09:00.');
    expect(strip).toHaveTextContent('It wakes earlier if the customer replies');
    await user.click(within(strip).getByRole('button', { name: 'Wake now' }));
    expect(onWake).toHaveBeenCalledTimes(1);
  });

  it('drops the name when nobody is known to have snoozed it, and the button for a reader who cannot write', () => {
    renderApp(
      <SnoozedStrip
        by={null}
        until="Sun 25 Oct, 09:00"
        canWake={false}
        busy={false}
        onWake={vi.fn()}
      />,
    );

    expect(screen.getByRole('status')).toHaveTextContent('Snoozed until Sun 25 Oct, 09:00.');
    expect(screen.queryByRole('button', { name: 'Wake now' })).not.toBeInTheDocument();
  });
});

describe('SnoozePickerDialog', () => {
  const open = (onSubmit = vi.fn()) =>
    renderApp(
      <SnoozePickerDialog
        open
        agentZone="Europe/Berlin"
        departmentName="Billing"
        departmentZone="Asia/Riyadh"
        busy={false}
        onClose={vi.fn()}
        onSubmit={onSubmit}
      />,
    );

  it('starts on a valid time, shows both zones and submits an instant', async () => {
    const onSubmit = vi.fn();
    const { user } = open(onSubmit);

    const dialog = await screen.findByRole('dialog', { name: 'Snooze until' });
    expect(within(dialog).getByLabelText('Time zone')).toHaveValue('Europe/Berlin');
    expect(dialog).toHaveTextContent('your time');
    expect(dialog).toHaveTextContent(/for Billing \(.*Asia\/Riyadh.*\)/);
    await user.click(within(dialog).getByRole('button', { name: 'Snooze' }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(Date.parse(onSubmit.mock.calls[0]?.[0] as string)).toBeGreaterThan(Date.now());
  });

  it('refuses a time more than ninety days ahead with an alert, and does not submit', async () => {
    const onSubmit = vi.fn();
    const { user } = open(onSubmit);
    const dialog = await screen.findByRole('dialog', { name: 'Snooze until' });
    const when = within(dialog).getByLabelText('Date and time');

    await user.clear(when);
    await user.type(when, '2099-01-01T10:00');

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Pick a time within the next 90 days.',
    );
    expect(within(dialog).getByRole('button', { name: 'Snooze' })).toBeDisabled();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('SnoozeControl', () => {
  const control = (api: MockTicketsApi, onSnooze = vi.fn(), openSignal = 0) =>
    renderApp(
      <SnoozeControl
        brandId={BRAND}
        ticketId={MOCK_TICKET_REFUND}
        busy={false}
        openSignal={openSignal}
        onSnooze={onSnooze}
      />,
      { ticketsApi: api },
    );

  it('offers the api’s presets with their times and the department’s zone, then snoozes to the one picked', async () => {
    const onSnooze = vi.fn();
    const { user } = control(new MockTicketsApi(undefined, NOW), onSnooze);

    await user.click(screen.getByRole('button', { name: 'Snooze' }));
    const menu = await screen.findByRole('menu', { name: 'Snooze until' });
    const items = await within(menu).findAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining('In 1 hour'),
      expect.stringContaining('In 4 hours'),
      expect.stringContaining('Next business day'),
      expect.stringContaining('Next week'),
      'Pick a date and time…',
    ]);
    expect(items[2]).toHaveTextContent('Asia/Tokyo');

    await user.click(items[1] as HTMLElement);
    expect(onSnooze).toHaveBeenCalledTimes(1);
    expect(typeof onSnooze.mock.calls[0]?.[0]).toBe('string');
  });

  it('opens on a new signal, as the h shortcut sends it', async () => {
    function Harness(): ReactNode {
      const [signal, setSignal] = useState(0);

      return (
        <>
          <button
            type="button"
            onClick={() => {
              setSignal(Date.now());
            }}
          >
            press h
          </button>
          <SnoozeControl
            brandId={BRAND}
            ticketId={MOCK_TICKET_REFUND}
            busy={false}
            openSignal={signal}
            onSnooze={vi.fn()}
          />
        </>
      );
    }
    const { user } = renderApp(<Harness />, { ticketsApi: new MockTicketsApi(undefined, NOW) });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'press h' }));

    expect(await screen.findByRole('menu', { name: 'Snooze until' })).toBeInTheDocument();
  });

  it('still offers the picker when the presets cannot be read', async () => {
    const api = new MockTicketsApi(undefined, NOW);
    vi.spyOn(api, 'snoozePresets').mockRejectedValue(new Error('offline'));
    const { user } = control(api);

    await user.click(screen.getByRole('button', { name: 'Snooze' }));
    const menu = await screen.findByRole('menu', { name: 'Snooze until' });

    expect(await within(menu).findByText(/times could not be loaded/)).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'Pick a date and time…' })).toBeEnabled();
  });
});
