import { expect, it } from 'vitest';
import { validInventoryTicketId } from './ticket-inventory.js';

it('preserves Zoho decimal-string IDs above JavaScript integer precision while refusing lossy Freshdesk IDs', () => {
  expect(validInventoryTicketId('zohodesk', '9007199254740993')).toBe(true);
  expect(validInventoryTicketId('freshdesk', '9007199254740993')).toBe(false);
  expect(validInventoryTicketId('freshdesk', '9001')).toBe(true);
});
it.each(['0', '001', '../1', '1e9', '=1+1', 'https://example.test'])(
  'refuses non-native ticket IDs before inventory publication: %s',
  (id) => {
    expect(validInventoryTicketId('freshdesk', id)).toBe(false);
    expect(validInventoryTicketId('zohodesk', id)).toBe(false);
  },
);
it('does not enable inventory parsing for a source without an implemented native-ID contract', () => {
  expect(validInventoryTicketId('front', '123')).toBe(false);
});
