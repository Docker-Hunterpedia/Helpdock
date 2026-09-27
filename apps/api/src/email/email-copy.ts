import { createI18n, dir, type Locale } from '@helpdock/i18n';
import type { AutoReplyKind, AutoReplyTemplate } from '@helpdock/schemas';

/**
 * Every sentence a customer email carries, from the `email` catalogs in the
 * customer's language (packages/i18n). Nothing here writes a sentence; it only
 * reads them.
 *
 * Auto-reply templates are read **raw**, with `getResource` rather than `t`:
 * their `{{ticket.number}}` placeholders are the template language an Admin
 * edits (artboard `AdminEmailOutgoing`), filled by {@link fillPlaceholders}
 * when the mail is sent, and i18next would otherwise interpolate them away.
 */

const i18n = createI18n();

const raw = (locale: Locale, key: string): string => {
  const value: unknown = i18n.getResource(locale, 'email', key);
  if (typeof value !== 'string') {
    throw new Error(`The email catalog has no ${locale} string at ${key}.`);
  }
  return value;
};

/** The shipped wording of one auto-reply, as the template editor starts from it. */
export const defaultAutoReplyTemplate = (
  kind: AutoReplyKind,
  locale: Locale,
): AutoReplyTemplate => ({
  subject: raw(locale, `autoReply.${kind}.subject`),
  body: raw(locale, `autoReply.${kind}.body`),
});

export interface PlaceholderValues {
  readonly ticketNumber: string;
  readonly contactFirstName: string;
  readonly departmentName: string;
  readonly brandName: string;
}

/**
 * The four placeholders the editor lists, and nothing else: a brace pair the
 * Admin typed that is not one of them is left as they typed it, so a template
 * never loses text to a guess.
 */
export const fillPlaceholders = (template: string, values: PlaceholderValues): string =>
  template
    .replaceAll('{{ticket.number}}', values.ticketNumber)
    .replaceAll('{{contact.first_name}}', values.contactFirstName)
    .replaceAll('{{department.name}}', values.departmentName)
    .replaceAll('{{brand.name}}', values.brandName);

/** "Mona Khalil" is addressed as "Mona"; a contact with no name as the catalog's fallback. */
export const firstNameOf = (name: string | null | undefined, locale: Locale): string => {
  const first = (name ?? '').trim().split(/\s+/u)[0] ?? '';
  return first === '' ? raw(locale, 'autoReply.fallbackName') : first;
};

export interface CustomerCopy {
  readonly dir: 'ltr' | 'rtl';
  readonly replyMarker: string;
  readonly referenceLabel: string;
  readonly replyHint: string;
  readonly autoReplyHint: string;
  readonly autoReplyNote: string;
  readonly footer: string;
  readonly replySubject: (reference: string, subject: string) => string;
  /** "Lina Haddad via Helpdock Billing", the display name of an agent's reply. */
  readonly fromVia: (agent: string, sender: string) => string;
}

export const customerCopy = (locale: Locale, brandName: string): CustomerCopy => {
  const t = i18n.getFixedT(locale, 'email');

  return {
    dir: dir(locale),
    replyMarker: t('customer.replyMarker'),
    referenceLabel: t('customer.referenceLabel'),
    replyHint: t('customer.replyHint'),
    autoReplyHint: t('customer.autoReplyHint'),
    autoReplyNote: t('customer.autoReplyNote'),
    footer: t('customer.footer', { brandName }),
    replySubject: (reference, subject) => t('customer.replySubject', { reference, subject }),
    fromVia: (agent, sender) => t('customer.fromVia', { agent, sender }),
  };
};

export interface TestMessageCopy {
  readonly subject: string;
  readonly heading: string;
  readonly body: string;
}

export const outgoingTestCopy = (
  locale: Locale,
  values: { readonly brandName: string; readonly host: string },
): TestMessageCopy => {
  const t = i18n.getFixedT(locale, 'email');

  return {
    subject: t('outgoingTest.subject', values),
    heading: t('outgoingTest.heading'),
    body: t('outgoingTest.body', values),
  };
};
