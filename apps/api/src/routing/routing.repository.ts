import {
  contactIdentities,
  contacts,
  type DbTransaction,
  departments,
  mailboxes,
  metaAccounts,
  tags,
  teams,
  telegramBots,
  ticketStatuses,
  type WorkflowRuleRow,
  webFormSettings,
  workflowRules,
} from '@helpdock/db';
import type { ContactIdentityKind, MetaPlatform, RoutingDepartmentRef } from '@helpdock/schemas';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { WebFormRepository } from '../web-form/web-form.repository.js';
import { WidgetRepository } from '../widget/widget.repository.js';

/**
 * The reads behind the Routing tab and Test routing (M14-09). Nothing here
 * writes, and every statement runs in the caller's transaction, so row-level
 * security narrows them as it does for every other read.
 *
 * Mailboxes, bots, accounts and the web form are configuration: brand-scoped,
 * not department-scoped. Which of them the reader may see is decided by the
 * department each files into, in the service.
 */

export interface MailboxEntry {
  readonly id: string;
  readonly address: string;
  readonly departmentId: string;
  readonly automatedAllowlist: readonly string[];
}

export interface BotEntry {
  readonly id: string;
  readonly username: string;
  readonly departmentId: string;
}

export interface MetaEntry {
  readonly id: string;
  readonly platform: MetaPlatform;
  readonly externalId: string;
  readonly displayName: string;
  readonly departmentId: string;
}

export interface WebFormEntry {
  readonly enabled: boolean;
  /** Null: the brand's first department. */
  readonly departmentId: string | null;
}

export interface ContactSummary {
  readonly id: string;
  readonly name: string;
  readonly locale: 'en' | 'ar' | null;
  readonly accountId: string | null;
  readonly emails: string[];
}

export class RoutingRepository {
  async mailboxes(tx: DbTransaction, brandId: string): Promise<MailboxEntry[]> {
    return tx
      .select({
        id: mailboxes.id,
        address: mailboxes.address,
        departmentId: mailboxes.departmentId,
        automatedAllowlist: mailboxes.automatedAllowlist,
      })
      .from(mailboxes)
      .where(eq(mailboxes.brandId, brandId))
      .orderBy(asc(mailboxes.address));
  }

  async telegramBots(tx: DbTransaction, brandId: string): Promise<BotEntry[]> {
    return tx
      .select({
        id: telegramBots.id,
        username: telegramBots.username,
        departmentId: telegramBots.departmentId,
      })
      .from(telegramBots)
      .where(eq(telegramBots.brandId, brandId))
      .orderBy(asc(telegramBots.username));
  }

  async metaAccounts(tx: DbTransaction, brandId: string): Promise<MetaEntry[]> {
    return tx
      .select({
        id: metaAccounts.id,
        platform: metaAccounts.platform,
        externalId: metaAccounts.externalId,
        displayName: metaAccounts.displayName,
        departmentId: metaAccounts.departmentId,
      })
      .from(metaAccounts)
      .where(eq(metaAccounts.brandId, brandId))
      .orderBy(asc(metaAccounts.platform), asc(metaAccounts.displayName));
  }

  /** No row means the defaults: off, in the brand's first department. */
  async webForm(tx: DbTransaction, brandId: string): Promise<WebFormEntry> {
    const [row] = await tx
      .select({ enabled: webFormSettings.enabled, departmentId: webFormSettings.departmentId })
      .from(webFormSettings)
      .where(eq(webFormSettings.brandId, brandId))
      .limit(1);

    return row ?? { enabled: false, departmentId: null };
  }

  /** Where a widget conversation is filed: the widget's own query, so the two cannot disagree. */
  widgetDepartmentId(tx: DbTransaction): Promise<string | undefined> {
    return new WidgetRepository().firstDepartment(tx);
  }

  /** Where a web form with no department of its own files: the form's own query. */
  formFallbackDepartmentId(tx: DbTransaction, brandId: string): Promise<string | undefined> {
    return new WebFormRepository().firstDepartmentId(tx, brandId);
  }

  async departments(
    tx: DbTransaction,
    brandId: string,
    ids: readonly string[],
  ): Promise<Map<string, RoutingDepartmentRef>> {
    if (ids.length === 0) {
      return new Map();
    }
    const rows = await tx
      .select({ id: departments.id, name: departments.name, nameAr: departments.nameAr })
      .from(departments)
      .where(and(eq(departments.brandId, brandId), inArray(departments.id, [...ids])));

    return new Map(rows.map((row) => [row.id, row]));
  }

  /** Every rule on *Ticket created*, enabled or not, in the order they run. */
  async createdRules(tx: DbTransaction): Promise<WorkflowRuleRow[]> {
    return tx
      .select()
      .from(workflowRules)
      .where(and(eq(workflowRules.kind, 'event'), eq(workflowRules.trigger, 'ticket_created')))
      .orderBy(asc(workflowRules.position), asc(workflowRules.id));
  }

  /** The status a new ticket lands in (DOMAIN-RULES §2.2). */
  async defaultStatusId(tx: DbTransaction): Promise<string | undefined> {
    const [row] = await tx
      .select({ id: ticketStatuses.id })
      .from(ticketStatuses)
      .where(eq(ticketStatuses.isDefault, true))
      .orderBy(asc(ticketStatuses.sortOrder))
      .limit(1);

    return row?.id;
  }

  async contactByIdentity(
    tx: DbTransaction,
    brandId: string,
    kind: ContactIdentityKind,
    value: string,
  ): Promise<ContactSummary | undefined> {
    const [identity] = await tx
      .select({ contactId: contactIdentities.contactId })
      .from(contactIdentities)
      .where(
        and(
          eq(contactIdentities.brandId, brandId),
          eq(contactIdentities.kind, kind),
          eq(contactIdentities.value, value),
        ),
      )
      .limit(1);
    if (identity === undefined) {
      return undefined;
    }

    const [contact] = await tx
      .select({
        id: contacts.id,
        name: contacts.name,
        locale: contacts.locale,
        accountId: contacts.accountId,
      })
      .from(contacts)
      .where(eq(contacts.id, identity.contactId))
      .limit(1);
    if (contact === undefined) {
      return undefined;
    }
    const emails = await tx
      .select({ value: contactIdentities.value })
      .from(contactIdentities)
      .where(and(eq(contactIdentities.contactId, contact.id), eq(contactIdentities.kind, 'email')))
      .orderBy(asc(contactIdentities.value));

    return { ...contact, emails: emails.map((email) => email.value) };
  }

  async teamName(
    tx: DbTransaction,
    teamId: string,
  ): Promise<{ id: string; name: string } | undefined> {
    const [row] = await tx
      .select({ id: teams.id, name: teams.name })
      .from(teams)
      .where(eq(teams.id, teamId))
      .limit(1);

    return row;
  }

  async tagNames(tx: DbTransaction, tagIds: readonly string[]): Promise<string[]> {
    if (tagIds.length === 0) {
      return [];
    }
    const rows = await tx
      .select({ name: tags.name })
      .from(tags)
      .where(inArray(tags.id, [...tagIds]))
      .orderBy(asc(tags.name));

    return rows.map((row) => row.name);
  }
}
