import type { DbTransaction } from '@helpdock/db';
import type {
  MetaPlatform,
  RoutingEntryKind,
  RoutingEntryPoint,
  RoutingEntryReason,
  RoutingTestRequest,
  TicketChannel,
} from '@helpdock/schemas';
import { NotFoundException } from '@nestjs/common';
import type { RoutingRepository } from './routing.repository.js';

/**
 * Step 1 of the pipeline: which department each door files into. The widget
 * and a web form without a department of its own use the brand's first
 * department, and an API request names its own (DOMAIN-RULES §2.8).
 */

export interface ResolvedEntry {
  readonly entry: RoutingEntryKind;
  readonly entryId: string | null;
  readonly label: string | null;
  readonly platform: MetaPlatform | null;
  /** A Meta account's own id on the platform; part of how its customers are known. */
  readonly externalId: string | null;
  readonly channel: TicketChannel;
  readonly departmentId: string | null;
  readonly reason: RoutingEntryReason;
  readonly enabled: boolean;
  readonly automatedAllowlist: readonly string[];
}

const NO_ALLOWLIST: readonly string[] = [];

const base = (entry: RoutingEntryKind, channel: TicketChannel) => ({
  entry,
  entryId: null,
  label: null,
  platform: null,
  externalId: null,
  channel,
  enabled: true,
  automatedAllowlist: NO_ALLOWLIST,
});

/** Every door the brand has, in the order the Routing tab lists them. */
export const allEntries = async (
  repository: RoutingRepository,
  tx: DbTransaction,
  brandId: string,
): Promise<ResolvedEntry[]> => {
  const [mailboxes, bots, accounts, form, first] = await Promise.all([
    repository.mailboxes(tx, brandId),
    repository.telegramBots(tx, brandId),
    repository.metaAccounts(tx, brandId),
    repository.webForm(tx, brandId),
    repository.firstDepartmentId(tx, brandId),
  ]);
  const own = 'entry_department' as const;

  return [
    ...mailboxes.map(
      (mailbox): ResolvedEntry => ({
        ...base('mailbox', 'email'),
        entryId: mailbox.id,
        label: mailbox.address,
        departmentId: mailbox.departmentId,
        reason: own,
        automatedAllowlist: mailbox.automatedAllowlist,
      }),
    ),
    {
      ...base('widget', 'chat'),
      departmentId: first ?? null,
      reason: 'brand_first_department',
    },
    ...bots.map(
      (bot): ResolvedEntry => ({
        ...base('telegram_bot', 'telegram'),
        entryId: bot.id,
        label: `@${bot.username}`,
        departmentId: bot.departmentId,
        reason: own,
      }),
    ),
    ...accounts.map(
      (account): ResolvedEntry => ({
        ...base('meta_account', account.platform),
        entryId: account.id,
        label: account.displayName,
        platform: account.platform,
        externalId: account.externalId,
        departmentId: account.departmentId,
        reason: own,
      }),
    ),
    {
      ...base('web_form', 'form'),
      enabled: form.enabled,
      departmentId: form.departmentId ?? first ?? null,
      reason: form.departmentId === null ? 'brand_first_department' : own,
    },
    { ...base('api_key', 'api'), departmentId: null, reason: 'named_by_api' },
  ];
};

export const toEntryPoint = (
  entry: ResolvedEntry,
  department: RoutingEntryPoint['department'],
): RoutingEntryPoint => ({
  entry: entry.entry,
  entryId: entry.entryId,
  label: entry.label,
  platform: entry.platform,
  channel: entry.channel,
  department,
  reason: entry.reason,
  enabled: entry.enabled,
});

/**
 * The door a test names, or a 404. An API request names its department, which
 * must be one of the brand's. The caller refuses a door whose department the
 * reader cannot reach with the same answer, so it does not say which it was.
 */
export const resolveEntry = async (
  repository: RoutingRepository,
  tx: DbTransaction,
  brandId: string,
  request: Pick<RoutingTestRequest, 'entry' | 'entryId' | 'departmentId'>,
): Promise<ResolvedEntry> => {
  const entries = await allEntries(repository, tx, brandId);
  const found = entries.find(
    (entry) => entry.entry === request.entry && entry.entryId === (request.entryId ?? null),
  );
  if (found === undefined) {
    throw new NotFoundException('No such entry point');
  }
  if (found.entry === 'api_key') {
    const named = request.departmentId;
    const department =
      named === undefined
        ? undefined
        : (await repository.departments(tx, brandId, [named])).get(named);
    if (department === undefined) {
      throw new NotFoundException('No such entry point');
    }
    return { ...found, departmentId: department.id };
  }
  if (found.departmentId === null) {
    throw new NotFoundException('No such entry point');
  }

  return found;
};
