import { describe, expect, it } from 'vitest';
import { purgeOrder, UnorderablePurgeError } from './brand-purge.js';

const key = (child: string, parent: string, blocking = true) => ({ child, parent, blocking });

describe('purgeOrder', () => {
  it('empties a table before every table it points at', () => {
    const order = purgeOrder(
      ['departments', 'tickets', 'ticket_messages', 'attachments'],
      [
        key('tickets', 'departments'),
        key('ticket_messages', 'tickets'),
        key('attachments', 'ticket_messages'),
      ],
    );

    expect(order).toEqual(['attachments', 'ticket_messages', 'tickets', 'departments']);
  });

  it('ignores keys to tables it is not purging, and a table’s keys to itself', () => {
    expect(purgeOrder(['tickets'], [key('tickets', 'users'), key('tickets', 'tickets')])).toEqual([
      'tickets',
    ]);
  });

  it('breaks a cycle at a key the database follows itself', () => {
    const order = purgeOrder(
      ['hc_settings', 'hc_media'],
      [key('hc_settings', 'hc_media', false), key('hc_media', 'hc_settings')],
    );

    expect(order).toEqual(['hc_media', 'hc_settings']);
  });

  it('refuses a cycle of keys that each block the delete, naming the tables', () => {
    expect(() => purgeOrder(['a', 'b'], [key('a', 'b'), key('b', 'a')])).toThrow(
      UnorderablePurgeError,
    );
  });
});
