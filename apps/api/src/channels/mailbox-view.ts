import type { InboundParseSettings as InboundParseSettingsRow } from '@helpdock/db';
import {
  type InboundParseSettings,
  inboundParseOutcomeSchema,
  inboundParseProviderSchema,
  type Mailbox,
  mailboxErrorKindSchema,
  mailboxHealth,
} from '@helpdock/schemas';
import type { MailboxWithNames } from './mailboxes.repository.js';

/**
 * A row as the Channels screen reads it. The password is reduced to "is there
 * one", which is the whole of what REQUIREMENTS §5.1 lets leave the server.
 */

const iso = (value: Date | null): string | null => value?.toISOString() ?? null;

export const toMailbox = (
  { mailbox, departmentName, passwordUpdatedByName }: MailboxWithNames,
  now: Date,
): Mailbox => {
  const errorKind = mailboxErrorKindSchema.safeParse(mailbox.lastErrorKind);

  return {
    id: mailbox.id,
    address: mailbox.address,
    displayName: mailbox.displayName,
    departmentId: mailbox.departmentId,
    departmentName,
    method: mailbox.method,
    imap:
      mailbox.method === 'imap' &&
      mailbox.imapHost !== null &&
      mailbox.imapPort !== null &&
      mailbox.imapSecurity !== null &&
      mailbox.imapUsername !== null
        ? {
            host: mailbox.imapHost,
            port: mailbox.imapPort,
            security: mailbox.imapSecurity,
            username: mailbox.imapUsername,
            folder: mailbox.imapFolder,
            pollIntervalSeconds: mailbox.pollIntervalSeconds,
            passwordSet: mailbox.imapPassword !== null,
            passwordUpdatedAt: iso(mailbox.imapPasswordUpdatedAt),
            passwordUpdatedByName,
          }
        : null,
    inboundProvider: mailbox.inboundProvider,
    remoteImages: mailbox.remoteImages,
    authFailureIsSpam: mailbox.authFailureIsSpam,
    automatedAllowlist: mailbox.automatedAllowlist,
    health: {
      state: mailboxHealth(mailbox, now),
      lastPolledAt: iso(mailbox.lastPolledAt),
      lastSuccessAt: iso(mailbox.lastSuccessAt),
      lastReceivedAt: iso(mailbox.lastReceivedAt),
      lastError: mailbox.lastError,
      lastErrorKind: errorKind.success ? errorKind.data : null,
      lastErrorAt: iso(mailbox.lastErrorAt),
    },
    createdAt: mailbox.createdAt.toISOString(),
  };
};

export const toInboundParseSettings = (
  row: InboundParseSettingsRow | undefined,
): InboundParseSettings => {
  const provider = inboundParseProviderSchema.safeParse(row?.lastRequestProvider);
  const outcome = inboundParseOutcomeSchema.safeParse(row?.lastRequestOutcome);

  return {
    secretSet: row?.secret != null,
    secretUpdatedAt: iso(row?.secretUpdatedAt ?? null),
    lastRequest:
      provider.success && outcome.success && row?.lastRequestAt != null
        ? { provider: provider.data, at: row.lastRequestAt.toISOString(), outcome: outcome.data }
        : null,
  };
};
