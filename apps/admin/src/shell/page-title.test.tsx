import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { pageTitle, usePageTitle } from './page-title.js';

describe('page title', () => {
  it('names the page before the product', () => {
    expect(pageTitle('Tickets')).toBe('Tickets · Helpdock');
    expect(pageTitle('  ')).toBe('Helpdock');
    expect(pageTitle(undefined)).toBe('Helpdock');
  });

  it('sets the document title and follows the page', () => {
    const { rerender } = renderHook(({ page }) => usePageTitle(page), {
      initialProps: { page: 'Reports' },
    });
    expect(document.title).toBe('Reports · Helpdock');
    rerender({ page: 'Contacts' });
    expect(document.title).toBe('Contacts · Helpdock');
  });
});
