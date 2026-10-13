import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderApp } from '../../../../test/render.tsx';
import {
  AccountHealth,
  AccountHealthLegend,
  accountHealthView,
  accountHealthWord,
  EXPIRING_WITHIN_MS,
} from './account-health.tsx';

const NOW = Date.parse('2026-10-11T12:00:00.000Z');
const inDays = (days: number): string => new Date(NOW + days * 24 * 60 * 60 * 1000).toISOString();

describe('accountHealthView', () => {
  it('is the api’s health for a token that does not expire', () => {
    expect(accountHealthView({ health: 'healthy', tokenExpiresAt: null }, NOW)).toBe('healthy');
    expect(accountHealthView({ health: 'waiting', tokenExpiresAt: null }, NOW)).toBe('waiting');
    expect(accountHealthView({ health: 'failing', tokenExpiresAt: null }, NOW)).toBe('failing');
  });

  it('calls a token with under a week left expiring, and one with more healthy', () => {
    expect(accountHealthView({ health: 'healthy', tokenExpiresAt: inDays(6.9) }, NOW)).toBe(
      'expiring',
    );
    expect(accountHealthView({ health: 'waiting', tokenExpiresAt: inDays(2) }, NOW)).toBe(
      'expiring',
    );
    expect(accountHealthView({ health: 'healthy', tokenExpiresAt: inDays(7.1) }, NOW)).toBe(
      'healthy',
    );
    expect(EXPIRING_WITHIN_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('keeps failing over expiring, because the failure is the news', () => {
    expect(accountHealthView({ health: 'failing', tokenExpiresAt: inDays(1) }, NOW)).toBe(
      'failing',
    );
  });
});

describe('accountHealthWord', () => {
  it('names the failure when the row says which', () => {
    const base = { health: 'failing', tokenExpiresAt: null } as const;

    expect(accountHealthWord({ ...base, status: 'token_expired' }, NOW)).toBe('tokenExpired');
    expect(accountHealthWord({ ...base, status: 'unsubscribed' }, NOW)).toBe('unsubscribed');
    expect(accountHealthWord({ ...base, status: 'connected' }, NOW)).toBe('failing');
    expect(
      accountHealthWord({ health: 'healthy', status: 'connected', tokenExpiresAt: null }, NOW),
    ).toBe('healthy');
  });
});

describe('AccountHealth', () => {
  it('says the state in words', () => {
    renderApp(
      <>
        <AccountHealth
          account={{ health: 'failing', status: 'token_expired', tokenExpiresAt: null }}
          now={NOW}
        />
        <AccountHealth
          account={{ health: 'healthy', status: 'connected', tokenExpiresAt: inDays(3) }}
          now={NOW}
        />
      </>,
    );

    expect(screen.getByText('Token expired')).toBeVisible();
    expect(screen.getByText('Expiring')).toBeVisible();
  });

  it('lists the four states in the legend', () => {
    renderApp(<AccountHealthLegend />);

    expect(screen.getAllByRole('listitem').map((item) => item.textContent?.split(':')[0])).toEqual([
      'Healthy',
      'Expiring',
      'Failing',
      'Waiting',
    ]);
  });
});
