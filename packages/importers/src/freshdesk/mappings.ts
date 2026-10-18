import type { ProposedMapping } from '../connector.js';

const priorities = new Map([
  ['1', 'low'],
  ['2', 'medium'],
  ['3', 'high'],
  ['4', 'urgent'],
]);
const channels = new Map([
  ['1', 'email'],
  ['2', 'form'],
  ['3', 'manual'],
  ['4', 'manual'],
  ['5', 'manual'],
  ['6', 'manual'],
  ['7', 'chat'],
  ['9', 'form'],
  ['10', 'email'],
]);

/** These remain proposals: brand mapping confirmation is mandatory before loading. */
export function freshdeskValueMapping(
  kind: 'priority' | 'channel',
  externalValue: string,
): ProposedMapping | null {
  const target = (kind === 'priority' ? priorities : channels).get(externalValue);
  return target ? { kind, externalValue, target: { [kind]: target } } : null;
}
