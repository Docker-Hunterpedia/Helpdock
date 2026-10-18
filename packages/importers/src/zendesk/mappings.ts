import type { ProposedMapping } from '../connector.js';

const PRIORITIES = new Map([
  ['low', 'low'],
  ['normal', 'medium'],
  ['high', 'high'],
  ['urgent', 'urgent'],
]);
const CHANNELS = new Map([
  ['email', 'email'],
  ['web', 'form'],
  ['api', 'api'],
  ['chat', 'chat'],
]);

export function zendeskValueMapping(
  kind: 'priority' | 'channel',
  externalValue: string,
): ProposedMapping | null {
  const target = (kind === 'priority' ? PRIORITIES : CHANNELS).get(externalValue);
  return target ? { kind, externalValue, target: { [kind]: target } } : null;
}
