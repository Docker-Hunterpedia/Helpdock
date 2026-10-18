import { type ImportRecord, importRecordSchema } from '@helpdock/schemas';
import { ConnectorError } from '../errors.js';
import { serializeImportValue } from '../hash.js';

const shared = [
  'country',
  'city',
  'state',
  'street',
  'zip',
  'ownerId',
  'isDeleted',
  'isTrashed',
] as const;
const native = {
  contact: [
    ...shared,
    'type',
    'title',
    'twitter',
    'facebook',
    'isSpam',
    'isAnonymous',
    'zohoCRMContact',
  ],
  organization: [
    ...shared,
    'website',
    'email',
    'phone',
    'fax',
    'code',
    'industry',
    'annualrevenue',
    'zohoCRMAccount',
    'associatedSLAIds',
  ],
  ticket: ['statusType', 'teamId', 'resolution'],
} as const;

export function zohoNativeFields(target: keyof typeof native): ImportRecord[] {
  return native[target].map((key) =>
    importRecordSchema.parse({
      entity: 'field',
      payload: {
        externalId: `${target}:native:${key}`,
        target,
        key: `zoho_${key}`,
        label: key,
        type: key.startsWith('is') ? 'checkbox' : key === 'resolution' ? 'textarea' : 'text',
      },
    }),
  );
}

/** Preserve unmapped native facts as explicit mapper fields; source roles/SLAs grant no behavior. */
export function zohoNativeValues(
  target: keyof typeof native,
  source: Record<string, unknown>,
  custom: Record<string, unknown>,
) {
  const result = { ...custom };
  for (const key of native[target]) {
    const value = source[key];
    if (value === undefined || value === null || value === '') continue;
    const destination = `zoho_${key}`;
    if (Object.hasOwn(result, destination)) throw new ConnectorError('invalid-response');
    result[destination] =
      typeof value === 'object' || typeof value === 'number' ? serializeImportValue(value) : value;
  }
  return result;
}
