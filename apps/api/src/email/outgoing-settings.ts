import type { EmailOutboundSettings, StoredAutoReplyTemplates } from '@helpdock/db';
import type { Locale } from '@helpdock/i18n';
import {
  type AutoReplies,
  type AutoReplyKind,
  type AutoReplyTemplates,
  type EmailSender,
  type EmailSenderKey,
  type EmailSenders,
  type OutgoingSmtp,
  smtpTlsModeSchema,
} from '@helpdock/schemas';
import { defaultAutoReplyTemplate } from './email-copy.js';

/**
 * The Outgoing email tab's row, both ways: what the screen is shown (with the
 * defaults a brand that never saved has), and which sender a message goes out
 * as. Pure, so every rule here is proved without a database.
 */

export const DEFAULT_HOURLY_CAP = 3;

const LOCALES: readonly Locale[] = ['en', 'ar'];

type Row = EmailOutboundSettings | undefined;

export const templatesFor = (row: Row, kind: AutoReplyKind): AutoReplyTemplates => {
  const stored = row?.autoReplyTemplates[kind];
  return {
    en: stored?.en ?? defaultAutoReplyTemplate(kind, 'en'),
    ar: stored?.ar ?? defaultAutoReplyTemplate(kind, 'ar'),
  };
};

export const autoRepliesFrom = (row: Row): AutoReplies => ({
  acknowledgment: {
    enabled: row?.acknowledgmentEnabled ?? false,
    templates: templatesFor(row, 'acknowledgment'),
  },
  outOfHours: {
    enabled: row?.outOfHoursEnabled ?? false,
    templates: templatesFor(row, 'outOfHours'),
  },
  perSenderHourlyCap: row?.autoReplyHourlyCap ?? DEFAULT_HOURLY_CAP,
});

/**
 * Only the wording that differs from the catalog is stored, so a brand that
 * saved the default keeps following the shipped wording as it improves.
 */
export const storedTemplatesFrom = (autoReplies: AutoReplies): StoredAutoReplyTemplates => {
  const stored: StoredAutoReplyTemplates = {};
  for (const kind of ['acknowledgment', 'outOfHours'] as const) {
    for (const locale of LOCALES) {
      const template = autoReplies[kind].templates[locale];
      const fallback = defaultAutoReplyTemplate(kind, locale);
      if (template.subject !== fallback.subject || template.body !== fallback.body) {
        stored[kind] = { ...stored[kind], [locale]: template };
      }
    }
  }
  return stored;
};

/**
 * The departments' senders for the screen, leaving out a department that has
 * since been deleted: its row would name nothing the Admin can pick.
 */
export const sendersFrom = (row: Row, departmentIds: ReadonlySet<string>): EmailSenders => ({
  defaultFrom:
    row?.defaultFromAddress == null
      ? null
      : { name: row.defaultFromName ?? '', address: row.defaultFromAddress },
  departments: (row?.departmentSenders ?? [])
    .filter((sender) => departmentIds.has(sender.departmentId))
    .map((sender) => ({
      departmentId: sender.departmentId,
      from: { name: sender.fromName, address: sender.fromAddress },
      replyTo: sender.replyTo,
    })),
});

export const smtpFrom = (row: Row, updatedByName: string | null): OutgoingSmtp | null => {
  if (row?.smtpHost == null || row.smtpPort == null) {
    return null;
  }
  const tls = smtpTlsModeSchema.safeParse(row.smtpTls);

  return {
    host: row.smtpHost,
    port: row.smtpPort,
    tls: tls.success ? tls.data : 'starttls',
    user: row.smtpUser ?? '',
    passwordSet: (row.smtpPassword ?? '') !== '',
    updatedAt: row.smtpUpdatedAt?.toISOString() ?? null,
    updatedByName,
  };
};

export interface ResolvedSender {
  readonly from: EmailSender;
  readonly replyTo: string | null;
}

/**
 * Who a message goes out as. A key picks one explicitly (the composer's From
 * select); without one, the ticket's department's sender, then the brand's
 * default, then the install's own `smtp.from`. Undefined only when there is
 * none at all, and then nothing can be sent.
 */
export const resolveSender = (
  row: Row,
  {
    departmentId,
    key,
  }: { readonly departmentId: string; readonly key?: EmailSenderKey | undefined },
  installFrom: EmailSender | undefined,
): ResolvedSender | undefined => {
  const brandDefault: ResolvedSender | undefined =
    row?.defaultFromAddress == null
      ? undefined
      : {
          from: { name: row.defaultFromName ?? '', address: row.defaultFromAddress },
          replyTo: null,
        };
  const install: ResolvedSender | undefined =
    installFrom === undefined ? undefined : { from: installFrom, replyTo: null };
  const forDepartment = (id: string): ResolvedSender | undefined => {
    const sender = row?.departmentSenders.find((candidate) => candidate.departmentId === id);
    return sender === undefined
      ? undefined
      : {
          from: { name: sender.fromName, address: sender.fromAddress },
          replyTo: sender.replyTo,
        };
  };

  if (key === 'default') {
    return brandDefault ?? install;
  }

  return forDepartment(key ?? departmentId) ?? brandDefault ?? install;
};

/** Every sender the From select offers: the default first, then each department's. */
export const senderOptions = (
  row: Row,
  installFrom: EmailSender | undefined,
): { key: EmailSenderKey; from: EmailSender }[] => {
  const fallback =
    row?.defaultFromAddress == null
      ? installFrom
      : { name: row.defaultFromName ?? '', address: row.defaultFromAddress };

  return [
    ...(fallback === undefined ? [] : [{ key: 'default' as const, from: fallback }]),
    ...(row?.departmentSenders ?? []).map((sender) => ({
      key: sender.departmentId,
      from: { name: sender.fromName, address: sender.fromAddress },
    })),
  ];
};

/** The key the From select starts on: the department's own sender when it has one. */
export const selectedSenderKey = (
  departmentId: string,
  options: readonly { key: EmailSenderKey }[],
): EmailSenderKey | null =>
  options.some((option) => option.key === departmentId)
    ? departmentId
    : (options.find((option) => option.key === 'default')?.key ?? null);
