import { type AssistLocale, detectLocale, type ThreadLine } from '@helpdock/ai';
import type { AssistMessage } from './assist.repository.js';

/**
 * A ticket's messages as the assistant reads them. Internal notes help an
 * agent's own tasks — a reply, a summary, a classification — and are left
 * out of anything a customer may read later: a drafted article is written
 * from public messages only (`Admin/Ticket-AI` panel 5).
 */

const roleOf = (message: AssistMessage): ThreadLine['role'] => {
  if (message.kind === 'note') {
    return 'note';
  }
  if (message.kind === 'ai' || message.authorType === 'ai') {
    return 'assistant';
  }
  return message.authorType === 'contact' ? 'customer' : 'agent';
};

export const threadLines = (
  messages: readonly AssistMessage[],
  { publicOnly }: { readonly publicOnly: boolean },
): ThreadLine[] =>
  messages
    .filter((message) => message.bodyText.trim() !== '')
    .filter((message) => !(publicOnly && message.kind === 'note'))
    .map((message) => ({ role: roleOf(message), text: message.bodyText }));

/**
 * The language a ticket is conducted in: that of what the customer said last
 * (the rule auto-reply applies to the message it answers), else the contact's
 * or the brand's. `complete()` takes it as the request's `locale` and sends
 * the brand's `systemPromptAr` for `ar`, so assist and auto-reply choose the
 * prompt in one place.
 */
export const conversationLocale = (
  lines: readonly ThreadLine[],
  fallback: AssistLocale,
): AssistLocale => {
  const lastCustomer = [...lines].reverse().find((line) => line.role === 'customer');
  return lastCustomer === undefined ? fallback : detectLocale(lastCustomer.text);
};

/** What retrieval is asked: the subject and what the customer said last. */
export const retrievalQuery = (subject: string, lines: readonly ThreadLine[]): string => {
  const lastCustomer = [...lines].reverse().find((line) => line.role === 'customer');
  return [subject, lastCustomer?.text ?? ''].join('\n').trim().slice(0, 2_000);
};
