import { DEFAULT_PRIORITY_NAMES, PRIORITY_KEYS } from '@helpdock/schemas';
import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import arTickets from '../../../../packages/i18n/locales/ar/tickets.json' with { type: 'json' };
import enTickets from '../../../../packages/i18n/locales/en/tickets.json' with { type: 'json' };
import { LOCALE_STORAGE_KEY } from '../app/preferences.js';
import { SessionProvider } from '../auth/session.tsx';
import { PriorityBadge } from '../screens/tickets/badges.tsx';
import { renderApp } from '../test/render.tsx';
import { signedInMockApis } from '../test/signed-in.js';
import { PriorityLabelsProvider, usePriorityLabel } from './priority-labels.tsx';

function Names(): React.ReactNode {
  const label = usePriorityLabel();

  return (
    <ul>
      {PRIORITY_KEYS.map((priority) => (
        <li key={priority} data-testid={priority}>
          {label(priority)}
        </li>
      ))}
    </ul>
  );
}

const render = async (labels: object) => {
  const apis = await signedInMockApis();
  await apis.ticketing.updatePriorityLabels('any', labels);
  const session = await apis.auth.me();
  if (session === null) {
    throw new Error('the fixture did not produce a session');
  }

  return renderApp(
    <SessionProvider session={session}>
      <PriorityLabelsProvider>
        <Names />
        <PriorityBadge priority="high" />
      </PriorityLabelsProvider>
    </SessionProvider>,
    { authApi: apis.auth, staffApi: apis.staff, ticketingApi: apis.ticketing },
  );
};

afterEach(() => {
  localStorage.removeItem(LOCALE_STORAGE_KEY);
});

describe('the default priority names the api checks against', () => {
  it('are the catalog names of both languages', () => {
    for (const priority of PRIORITY_KEYS) {
      expect(DEFAULT_PRIORITY_NAMES.en[priority]).toBe(enTickets.priority[priority]);
      expect(DEFAULT_PRIORITY_NAMES.ar[priority]).toBe(arTickets.priority[priority]);
    }
  });
});

describe('usePriorityLabel (M1-02)', () => {
  it('gives the brand’s English name, and the catalog default for a priority with none', async () => {
    await render({ high: { en: 'P2' }, urgent: { en: 'P1', ar: 'حرجة' } });

    expect(await screen.findByTestId('high')).toHaveTextContent('P2');
    expect(screen.getByTestId('urgent')).toHaveTextContent('P1');
    expect(screen.getByTestId('low')).toHaveTextContent('Low');
    expect(screen.getAllByText('P2')).toHaveLength(2);
  });

  it('gives the Arabic name in the Arabic interface, and falls back per language', async () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, 'ar');
    await render({ high: { en: 'P2' }, urgent: { en: 'P1', ar: 'حرجة' } });

    expect(await screen.findByTestId('urgent')).toHaveTextContent('حرجة');
    // High has an English name only, so the Arabic interface shows the Arabic default.
    expect(screen.getByTestId('high')).toHaveTextContent('عالية');
    expect(screen.getByTestId('medium')).toHaveTextContent('متوسطة');
  });

  it('answers the catalog default outside a signed-in shell', () => {
    renderApp(<Names />);

    expect(screen.getByTestId('urgent')).toHaveTextContent('Urgent');
  });
});
