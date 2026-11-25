import type { PowChallenge } from '@helpdock/channels';
import type { RateLimitRule } from '../auth/rate-limit.js';
import type {
  ConfirmOutcome,
  PortalCaptcha,
  PortalSecurityLog,
  PortalStore,
} from '../portal/portal-site.js';
import type { LiveSession, TokenState } from '../portal/portal-store.js';
import { createHash } from 'node:crypto';

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
}

export class MemoryPortalStore implements PortalStore {
  /** Known addresses of the brand, by address. */
  readonly known = new Map<string, { contactId: string; companyName: string | null }>();
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
    return Promise.resolve({
      id: found.id,
      brandId: found.brandId,
      contactId: found.contactId,
      address: found.address,
      companyName: this.known.get(found.address)?.companyName ?? null,
    });
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
