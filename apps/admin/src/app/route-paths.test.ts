import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SIGNED_IN_ROUTE,
  safeReturnTo,
  ticketIdFromPath,
  ticketRoute,
} from './route-paths.js';

describe('safeReturnTo', () => {
  it('keeps a path inside the app', () => {
    expect(safeReturnTo('/admin/settings?tab=email')).toBe('/admin/settings?tab=email');
  });

  it.each([
    ['nothing', null],
    ['an empty value', ''],
    ['an absolute url', 'https://evil.example/steal'],
    ['a protocol-relative url', '//evil.example'],
    ['a relative path', 'admin/settings'],
  ])('falls back to the default screen for %s', (_case, value) => {
    expect(safeReturnTo(value)).toBe(DEFAULT_SIGNED_IN_ROUTE);
  });
});

describe('ticketIdFromPath', () => {
  it('is the id the workspace has open', () => {
    expect(ticketIdFromPath('/tickets/0192c3f0')).toBe('0192c3f0');
  });

  it('is null on the list itself', () => {
    expect(ticketIdFromPath('/tickets')).toBeNull();
    expect(ticketIdFromPath('/tickets/')).toBeNull();
  });

  it('is null anywhere else in the app', () => {
    expect(ticketIdFromPath('/contacts/0192c3f0')).toBeNull();
  });

  it('decodes what the link encoded', () => {
    expect(ticketIdFromPath(ticketRoute('a/b'))).toBe('a/b');
  });

  it('ignores anything past the id rather than reading it as one', () => {
    expect(ticketIdFromPath('/tickets/0192c3f0/whatever')).toBe('0192c3f0');
  });
});
