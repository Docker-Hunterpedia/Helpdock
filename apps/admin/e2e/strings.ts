import { createI18n, type Locale, NAMESPACES } from '@helpdock/i18n';

const instances = new Map<Locale, ReturnType<typeof createI18n>>();

/**
 * The catalogs, read the same way the app reads them. Spelling Arabic copy out
 * in every spec would be unreadable and would drift; the exact English wording
 * is asserted literally in the unit tests instead, and the parity test in
 * `packages/i18n` keeps the two catalogs in step.
 */
export function strings(locale: Locale) {
  let instance = instances.get(locale);
  if (!instance) {
    instance = createI18n({ lng: locale });
    instances.set(locale, instance);
  }

  const t = instance.getFixedT(locale, [...NAMESPACES]);

  return t;
}
