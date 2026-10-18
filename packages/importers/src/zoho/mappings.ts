import type { ProposedMapping } from '../connector.js';

const priorities = new Map([
  ['low', 'low'],
  ['medium', 'medium'],
  ['high', 'high'],
]);
const channels = new Map([
  ['email', 'email'],
  ['chat', 'chat'],
  ['phone', 'manual'],
  ['forums', 'manual'],
  ['feedback', 'form'],
  ['facebook', 'manual'],
  ['twitter', 'manual'],
  ['youtube', 'manual'],
]);

/** Custom values remain unmapped; source social posts do not establish a Helpdock messaging account. */
export function zohoValueMapping(
  kind: 'priority' | 'channel',
  externalValue: string,
): ProposedMapping | null {
  const mapped = (kind === 'priority' ? priorities : channels).get(externalValue.toLowerCase());
  return mapped ? { kind, externalValue, target: { [kind]: mapped } } : null;
}
