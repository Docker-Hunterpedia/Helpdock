import { TICKET_PREFIX } from '@helpdock/schemas';

/**
 * A ticket's public reference, `HD-1042`: the brand's prefix as the ticket was
 * created with it, a dash and its number (DOMAIN-RULES §11). The portal's ticket
 * address carries it, so what a customer reads in an email is what the address
 * says.
 */
export interface TicketReference {
  readonly prefix: string;
  readonly number: number;
}

const REFERENCE = /^([A-Za-z0-9]{2,6})-([0-9]{1,12})$/;

export const formatTicketReference = (prefix: string, number: number): string =>
  `${prefix}-${String(number)}`;

/** The prefix and number a reference names, or null for anything that is not one. Case does not matter. */
export const parseTicketReference = (value: string): TicketReference | null => {
  const match = REFERENCE.exec(value.trim());
  if (match === null) {
    return null;
  }
  const prefix = (match[1] ?? '').toUpperCase();
  const number = Number(match[2]);
  return TICKET_PREFIX.test(prefix) && Number.isSafeInteger(number) && number > 0
    ? { prefix, number }
    : null;
};
