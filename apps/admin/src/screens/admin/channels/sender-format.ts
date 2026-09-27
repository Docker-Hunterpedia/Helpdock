import type { EmailSender } from '@helpdock/schemas';
import { z } from 'zod';

/**
 * The senders table edits a From as one line, `Helpdock Billing
 * <billing@helpdock.io>`, the way a mail client shows it. These two functions
 * are the only place that line is read or written.
 */

const ADDRESS = z.email().max(320);
const NAMED = /^\s*(.*?)\s*<\s*([^<>\s]+)\s*>\s*$/u;

export const formatSender = (sender: EmailSender | null): string => {
  if (sender === null) {
    return '';
  }
  return sender.name === '' ? sender.address : `${sender.name} <${sender.address}>`;
};

/** The sender a line names, or null when it is not one an api would accept. */
export const parseSender = (line: string): EmailSender | null => {
  const trimmed = line.trim();
  const named = NAMED.exec(trimmed);
  const name = named === null ? '' : (named[1] ?? '').replace(/^"|"$/gu, '').trim();
  const address = named === null ? trimmed : (named[2] ?? '');

  if (!ADDRESS.safeParse(address).success || name.length > 120) {
    return null;
  }
  return { name, address };
};

/** An optional Reply-To: empty is none, anything else must be an address. */
export const parseReplyTo = (value: string): { ok: true; value: string | null } | { ok: false } => {
  const trimmed = value.trim();
  if (trimmed === '') {
    return { ok: true, value: null };
  }
  return ADDRESS.safeParse(trimmed).success ? { ok: true, value: trimmed } : { ok: false };
};
