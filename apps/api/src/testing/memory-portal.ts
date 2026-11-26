import { createHash } from 'node:crypto';
import type { PowChallenge } from '@helpdock/channels';
import type { RateLimitRule } from '../auth/rate-limit.js';
import type {
  ConfirmOutcome,
  PortalCaptcha,
  PortalSecurityLog,
  PortalStore,
} from '../portal/portal-site.js';
import type { LiveSession, TokenState } from '../portal/portal-store.js';
import type { TicketListQuery } from '../portal/ticket-list-rules.js';
import type { TicketReference } from '../portal/ticket-reference.js';
import type {
  AttachmentLookup,
  PortalMessage,
  PortalOpenedBy,
  PortalTicket,
  PortalTicketList,
  PortalTicketRow,
  TicketLookup,
} from '../portal/ticket-views.js';

/**
 * The portal's store, limiter and CAPTCHA held in memory, for the pages' unit
 * suite and the Playwright server (`apps/api/e2e/help-center-server.ts`), which
 * drive `PortalSite` without a database. The rules it applies are the real
 * store's (`db-portal-store.ts`), which the integration suite proves against
 * Postgres: a link for a known address (or any address when new customers may
 * sign in), single use, 15 minutes, a session bound to brand and host.
 */

// Local copies of the pure rules, as plain values: the Playwright server runs this
// file straight from source, where a `.js` import of a sibling `.ts` does not
// resolve. `session-rules.test.ts` proves the real constants.
const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');
const isExpired = (expiresAt: Date, now: Date): boolean => expiresAt.getTime() <= now.getTime();
const signInExpiry = (now: Date): Date => new Date(now.getTime() + 15 * 60_000);
const sessionExpiry = (now: Date): Date => new Date(now.getTime() + 30 * 86_400_000);

export interface SentLink {
  readonly to: string;
  readonly url: string;
  readonly locale: string;
}

interface Link {
  readonly brandId: string;
  readonly email: string;
  readonly hash: string;
  expiresAt: Date;
  spentAt: Date | null;
}

interface Session {
  readonly id: string;
  readonly brandId: string;
  readonly contactId: string;
  readonly address: string;
  readonly hash: string;
  readonly host: string;
  expiresAt: Date;
  lastSeenAt: Date;
}

/** What the memory store knows of a customer: who, which company, and what the account lets them see. */
export interface KnownCustomer {
  contactId: string;
  companyName: string | null;
  /** The account's id when there is one; tickets with the same `company` belong to it. */
  accountId?: string;
  visibility?: 'own' | 'managers' | 'all';
  role?: 'member' | 'manager';
}

/** A ticket fixture. `author` is relative to nobody: the store turns it into "you", "coworker" and so on per viewer. */
export interface MemoryTicket {
  readonly reference: string;
  readonly subject: string;
  readonly status: PortalTicketRow['status'];
  readonly updatedAt: Date;
  readonly createdAt: Date;
  readonly channel: PortalTicket['channel'];
  /** The contact who opened it. */
  readonly opener: { readonly contactId: string; readonly name: string };
  /** The account whose members may see it under "all"; null for a ticket with no company. */
  readonly accountId: string | null;
  readonly private: boolean;
  readonly messages: readonly {
    readonly id: string;
    readonly by:
      | { readonly kind: 'contact'; readonly contactId: string; readonly name: string }
      | { readonly kind: 'staff'; readonly name: string }
      | { readonly kind: 'brand' };
    readonly at: Date;
    readonly text: string;
    readonly files?: readonly {
      readonly id: string;
      readonly name: string;
      readonly mime: string;
      readonly size: number;
    }[];
  }[];
}

const ticketUuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const PAGE = 20;

export class MemoryPortalStore implements PortalStore {
  /** Known addresses of the brand, by address. */
  readonly known = new Map<string, KnownCustomer>();
  /** Every ticket of the brand, for the list and the page. */
  readonly fixtures: MemoryTicket[] = [];
  newCustomers = false;
  readonly sent: SentLink[] = [];
  readonly links: Link[] = [];
  readonly sessions: Session[] = [];
  #counter = 0;

  issueLink(input: Parameters<PortalStore['issueLink']>[0]): Promise<'issued' | 'skipped'> {
    if (!this.known.has(input.email) && !this.newCustomers) {
      return Promise.resolve('skipped');
    }
    this.links.push({
      brandId: input.brandId,
      email: input.email,
      hash: input.tokenHash,
      expiresAt: signInExpiry(input.now),
      spentAt: null,
    });
    this.sent.push({ to: input.email, url: input.confirmUrl(input.token), locale: input.locale });
    return Promise.resolve('issued');
  }

  readLink(brandId: string, token: string, now: Date): Promise<TokenState> {
    const link = this.links.find((candidate) => candidate.hash === hashToken(token));
    if (link === undefined || link.brandId !== brandId) {
      return Promise.resolve({ state: 'expired' });
    }
    if (link.spentAt !== null) {
      return Promise.resolve({ state: 'used' });
    }
    return Promise.resolve(
      isExpired(link.expiresAt, now)
        ? { state: 'expired' }
        : { state: 'live', id: link.hash, email: link.email, contactId: null },
    );
  }

  async confirm(input: Parameters<PortalStore['confirm']>[0]): Promise<ConfirmOutcome> {
    const link = await this.readLink(input.brandId, input.token, input.now);
    if (link.state !== 'live') {
      return { kind: link.state };
    }
    const found = this.links.find((candidate) => candidate.hash === link.id);
    if (found !== undefined) {
      found.spentAt = input.now;
    }
    this.#counter += 1;
    const contactId = this.known.get(link.email)?.contactId ?? `contact-${String(this.#counter)}`;
    this.sessions.push({
      id: `session-${String(this.#counter)}`,
      brandId: input.brandId,
      contactId,
      address: link.email,
      hash: input.sessionTokenHash,
      host: input.host,
      expiresAt: sessionExpiry(input.now),
      lastSeenAt: input.now,
    });
    return { kind: 'signed-in', contactId };
  }

  session(input: Parameters<PortalStore['session']>[0]): Promise<LiveSession | null> {
    const found = this.sessions.find((candidate) => candidate.hash === hashToken(input.token));
    if (
      found === undefined ||
      found.brandId !== input.brandId ||
      found.host !== input.host ||
      isExpired(found.expiresAt, input.now)
    ) {
      return Promise.resolve(null);
    }
    // As the real store: the expiry slides, and `lastSeenAt` is written, at most every 15 minutes.
    const touched = input.now.getTime() - found.lastSeenAt.getTime() >= 15 * 60_000;
    if (touched) {
      found.lastSeenAt = input.now;
      found.expiresAt = sessionExpiry(input.now);
    }
    const customer = this.known.get(found.address);
    const visibility = customer?.visibility ?? 'own';
    const role = customer?.role ?? 'member';
    const sees =
      customer?.accountId !== undefined &&
      (visibility === 'all' || (visibility === 'managers' && role === 'manager'))
        ? 'account'
        : 'own';
    return Promise.resolve({
      id: found.id,
      brandId: found.brandId,
      contactId: found.contactId,
      address: found.address,
      companyName: customer?.companyName ?? null,
      touched,
      scope: {
        brandId: found.brandId,
        contactId: found.contactId,
        accountId: customer?.accountId ?? null,
        sees,
        visibility,
        role,
        departmentIds: 'all',
      },
    });
  }

  /** The tickets this customer may see: their own, or the company's under "all" (never a private one). */
  #visible(session: LiveSession, which: 'mine' | 'company'): MemoryTicket[] {
    const scope = session.scope;
    return this.fixtures.filter((ticket) => {
      if (ticket.opener.contactId === session.contactId) {
        return true;
      }
      return (
        which === 'company' &&
        scope?.sees === 'account' &&
        ticket.accountId !== null &&
        ticket.accountId === scope.accountId &&
        !ticket.private
      );
    });
  }

  tickets(session: LiveSession, query: TicketListQuery): Promise<PortalTicketList> {
    const inState = (ticket: MemoryTicket): boolean =>
      (ticket.status === 'solved') === (query.state === 'solved');
    const matches = (ticket: MemoryTicket): boolean => {
      if (query.search.kind === 'none') {
        return true;
      }
      const { text, reference } = query.search;
      const number = ticket.reference.split('-')[1];
      return (
        ticket.subject.toLowerCase().includes(text.toLowerCase()) ||
        (reference !== null &&
          ('prefix' in reference
            ? ticket.reference === `${reference.prefix}-${String(reference.number)}`
            : number === String(reference.number)))
      );
    };
    const sorted = this.#visible(session, query.scope)
      .filter(inState)
      .filter(matches)
      .map((ticket, index) => ({ ticket, id: ticketUuid(index + 1) }))
      .sort((a, b) => b.ticket.updatedAt.getTime() - a.ticket.updatedAt.getTime());
    const after =
      query.cursor === null
        ? sorted
        : sorted.filter(
            ({ ticket }) => ticket.updatedAt.getTime() < (query.cursor?.updatedAt.getTime() ?? 0),
          );
    const page = after.slice(0, PAGE);
    const last = page.at(-1);
    const count = (which: 'mine' | 'company'): number =>
      this.#visible(session, which).filter(inState).length;
    return Promise.resolve({
      rows: page.map(({ ticket }) => ({
        reference: ticket.reference,
        subject: ticket.subject,
        status: ticket.status,
        updatedAt: ticket.updatedAt.toISOString(),
        openedBy: query.scope === 'company' ? openedBy(session, ticket) : null,
        onlyYou: ticket.private && ticket.opener.contactId === session.contactId,
      })),
      nextCursor:
        after.length > PAGE && last !== undefined
          ? Buffer.from(
              JSON.stringify({ u: last.ticket.updatedAt.toISOString(), i: last.id }),
            ).toString('base64url')
          : null,
      counts: {
        mine: count('mine'),
        company: session.scope?.sees === 'account' ? count('company') : null,
      },
    });
  }

  ticket(session: LiveSession, reference: TicketReference): Promise<TicketLookup> {
    const wanted = `${reference.prefix}-${String(reference.number)}`;
    const ticket = this.#visible(session, 'company').find((entry) => entry.reference === wanted);
    if (ticket === undefined) {
      return Promise.resolve({ kind: 'missing' });
    }
    const messages: PortalMessage[] = ticket.messages.map((message) => ({
      id: message.id,
      author:
        message.by.kind === 'staff'
          ? { kind: 'staff', name: message.by.name }
          : message.by.kind === 'brand'
            ? { kind: 'brand' }
            : message.by.contactId === session.contactId
              ? { kind: 'you' }
              : { kind: 'coworker', name: message.by.name },
      at: message.at.toISOString(),
      text: message.text,
      attachments: (message.files ?? []).map((file) => ({ ...file, kind: 'document' })),
    }));
    return Promise.resolve({
      kind: 'found',
      ticket: {
        reference: ticket.reference,
        subject: ticket.subject,
        status: ticket.status,
        openedBy: openedBy(session, ticket),
        createdAt: ticket.createdAt.toISOString(),
        channel: ticket.channel,
        mine: ticket.opener.contactId === session.contactId,
        messages,
      },
    });
  }

  attachment(
    session: LiveSession,
    reference: TicketReference,
    attachmentId: string,
  ): Promise<AttachmentLookup> {
    const wanted = `${reference.prefix}-${String(reference.number)}`;
    const ticket = this.#visible(session, 'company').find((entry) => entry.reference === wanted);
    const file = ticket?.messages
      .flatMap((message) => message.files ?? [])
      .find((f) => f.id === attachmentId);
    return Promise.resolve(file === undefined ? null : { url: `/__e2e/file/${file.name}` });
  }

  /** For a browser test: every link emailed to this address is now past its fifteen minutes. */
  expireLinks(email: string): void {
    for (const link of this.links) {
      if (link.email === email) {
        link.expiresAt = new Date(0);
      }
    }
  }

  endSession(_brandId: string, sessionId: string): Promise<void> {
    const index = this.sessions.findIndex((candidate) => candidate.id === sessionId);
    if (index >= 0) {
      this.sessions.splice(index, 1);
    }
    return Promise.resolve();
  }

  endAllSessions(brandId: string, contactId: string): Promise<void> {
    for (let index = this.sessions.length - 1; index >= 0; index -= 1) {
      const session = this.sessions[index];
      if (session?.brandId === brandId && session.contactId === contactId) {
        this.sessions.splice(index, 1);
      }
    }
    return Promise.resolve();
  }
}

const openedBy = (session: LiveSession, ticket: MemoryTicket): PortalOpenedBy =>
  ticket.opener.contactId === session.contactId
    ? { kind: 'you' }
    : { kind: 'person', name: ticket.opener.name };

/** Counts per rule and subject, never expiring: a test's budget is one test long. */
export class MemoryLimiter {
  readonly #used = new Map<string, number>();

  consume(rule: RateLimitRule, subject: string): Promise<boolean> {
    const key = `${rule.bucket}:${subject}`;
    const used = (this.#used.get(key) ?? 0) + 1;
    this.#used.set(key, used);
    return Promise.resolve(used <= rule.limit);
  }
}

/** A built-in check a test can switch on; solutions are accepted when they say `ok`. */
export class MemoryCaptcha implements PortalCaptcha {
  on = false;

  required(): Promise<boolean> {
    return Promise.resolve(this.on);
  }

  challenge(): Promise<PowChallenge | null> {
    return Promise.resolve(
      this.on
        ? {
            algorithm: 'SHA-256',
            challenge: '0'.repeat(64),
            maxnumber: 1000,
            salt: 'salt',
            signature: 'signature',
            expiresIn: 900,
          }
        : null,
    );
  }

  spend(_brandId: string, token: string): Promise<boolean> {
    return Promise.resolve(token === 'ok');
  }
}

export const silentSecurityLog = (): PortalSecurityLog & {
  readonly events: Record<string, unknown>[];
} => {
  const events: Record<string, unknown>[] = [];
  return {
    events,
    info: (fields) => void events.push(fields),
    warn: (fields) => void events.push(fields),
  };
};
