import { timezoneSchema } from '@helpdock/schemas';
import type { ContactLoad } from './profile-contracts.js';

export function importedContactValues(input: ContactLoad) {
  const language = input.record.locale?.trim().replaceAll('_', '-').split('-')[0]?.toLowerCase();
  const locale: 'en' | 'ar' | null = language === 'en' || language === 'ar' ? language : null;
  const timezone =
    input.record.timezone && timezoneSchema.safeParse(input.record.timezone).success
      ? input.record.timezone
      : null;
  return {
    locale,
    timezone,
    importedDetails: {
      phones: input.record.phones,
      locale: input.record.locale ?? null,
      timezone: input.record.timezone ?? null,
      ...(input.record.notes === undefined ? {} : { notes: input.record.notes }),
      ...(input.record.description === undefined ? {} : { description: input.record.description }),
      ...(input.record.createdAt === undefined ? {} : { createdAt: input.record.createdAt }),
      ...(input.record.updatedAt === undefined ? {} : { updatedAt: input.record.updatedAt }),
      ...(input.record.sourceIdentities === undefined
        ? {}
        : { sourceIdentities: input.record.sourceIdentities }),
    },
  };
}
