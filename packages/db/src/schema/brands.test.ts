import { describe, expect, it } from 'vitest';
import { uuidv7 } from '../uuid.js';
import { brandTicketSequenceName } from './brands.js';

describe('brandTicketSequenceName', () => {
  it('matches the name the insert trigger builds', () => {
    expect(brandTicketSequenceName('0199a2bc-1f00-7a3d-8b2e-1f6c9d2e4a7b')).toBe(
      'brand_ticket_seq_0199a2bc1f007a3d8b2e1f6c9d2e4a7b',
    );
  });

  it('stays inside the 63 character limit Postgres puts on an identifier', () => {
    expect(brandTicketSequenceName(uuidv7()).length).toBeLessThanOrEqual(63);
  });

  it.each(['', 'acme', "0199a2bc-1f00-7a3d-8b2e-1f6c9d2e4a7b'; drop table brands; --"])(
    'refuses %s, which would end up in an identifier',
    (brandId) => {
      expect(() => brandTicketSequenceName(brandId)).toThrow(TypeError);
    },
  );
});
