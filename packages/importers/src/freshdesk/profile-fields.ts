import { type ImportRecord, importRecordSchema } from '@helpdock/schemas';
import { ConnectorError } from '../errors.js';
import { serializeImportValue } from '../hash.js';

const contactFields = [
  ['address', 'text'],
  ['job_title', 'text'],
  ['contact_type', 'text'],
  ['twitter_id', 'text'],
  ['social_handler', 'text'],
  ['tags', 'text'],
  ['other_companies', 'text'],
  ['devices', 'text'],
  ['view_all_tickets', 'checkbox'],
] as const;
const companyFields = [
  ['health_score', 'text'],
  ['account_tier', 'text'],
  ['renewal_date', 'date'],
  ['industry', 'text'],
] as const;

/** Native source attributes have explicit mapper choices, just like vendor custom fields. */
export function freshdeskProfileFields(target: 'contact' | 'organization'): ImportRecord[] {
  return (target === 'contact' ? contactFields : companyFields).map(([name, type]) =>
    importRecordSchema.parse({
      entity: 'field',
      payload: {
        externalId: `${target}:native:${name}`,
        target,
        key: `freshdesk_${name}`,
        label: name,
        type,
      },
    }),
  );
}

export function freshdeskProfileValues(
  target: 'contact' | 'organization',
  source: Record<string, unknown>,
  custom: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...custom };
  for (const [name] of target === 'contact' ? contactFields : companyFields) {
    const value = source[name];
    if (
      value === undefined ||
      value === null ||
      value === '' ||
      (Array.isArray(value) && !value.length)
    )
      continue;
    const key = `freshdesk_${name}`;
    if (Object.hasOwn(result, key)) throw new ConnectorError('invalid-response');
    result[key] = typeof value === 'object' ? serializeImportValue(value) : value;
  }
  return result;
}
