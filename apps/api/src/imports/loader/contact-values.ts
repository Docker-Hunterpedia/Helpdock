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
    },
  };
}
