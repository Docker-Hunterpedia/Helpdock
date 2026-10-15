import { normaliseEmail, normalisePhone } from '@helpdock/schemas';
import type { ContactLoad } from './profile-contracts.js';

type ImportedIdentifier = { kind: 'email' | 'phone'; value: string };
export function importedContactIdentifiers(input: ContactLoad): {
  identifiers: ImportedIdentifier[];
  refusedPhones: number;
} {
  const identifiers = new Map<string, ImportedIdentifier>();
  let refusedPhones = 0;
  for (const email of input.record.emails) {
    const normalized = normaliseEmail(email);
    if (normalized.ok)
      identifiers.set(`email:${normalized.value}`, { kind: 'email', value: normalized.value });
  }
  for (const phone of input.record.phones) {
    const normalized = normalisePhone(phone, { defaultCallingCode: input.defaultCallingCode });
    if (!normalized.ok) {
      refusedPhones += 1;
      continue;
    }
    identifiers.set(`phone:${normalized.value}`, { kind: 'phone', value: normalized.value });
  }
  return { identifiers: [...identifiers.values()], refusedPhones };
}
