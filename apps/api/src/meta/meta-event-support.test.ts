import type { MetaEvent, MetaInboundMessage } from '@helpdock/channels';
import type { DbTransaction, MetaAccount, MetaConversation } from '@helpdock/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ContactFailure } from '../contacts/contact-failure.js';
import {
  askForProfile,
  dropEcho,
  duplicate,
  handled,
  ignored,
  instantOf,
  otherEvent,
  routeContextOf,
  routeOrDrop,
} from './meta-event-support.js';
import { enqueueMetaProfile } from './meta-events.js';
import type { MetaEventContext, MetaInboundLog } from './meta-inbound.service.js';

// The outbox row is the integration suites' to prove; here only that it is asked for.
vi.mock('./meta-events.js', () => ({
  enqueueMetaProfile: vi.fn(() => Promise.resolve('outbox-id')),
}));

const NOW = new Date('2026-10-11T08:00:00Z');
const tx = {} as DbTransaction;

const account = (platform: 'whatsapp' | 'messenger' | 'instagram' = 'messenger') =>
  ({
    id: 'account-1',
    brandId: 'brand-1',
    departmentId: 'dept-1',
    platform,
    status: 'connected',
    externalId: '112233445566778',
  }) as MetaAccount;

const contextOf = (over: Partial<MetaAccount> = {}): MetaEventContext => ({
  tx,
  account: { ...account(), ...over },
  now: NOW,
});

const logOf = (): MetaInboundLog => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

beforeEach(() => {
  vi.mocked(enqueueMetaProfile).mockClear();
});

describe('the outcomes', () => {
  it('are handled, duplicate or ignored with one reason from one vocabulary', () => {
    expect(handled).toEqual({ outcome: 'handled' });
    expect(duplicate).toEqual({ outcome: 'duplicate' });
    expect(ignored('no-open-ticket')).toEqual({ outcome: 'ignored', reason: 'no-open-ticket' });
  });
});

describe('instantOf', () => {
  it('is Meta’s time when it is not in the future', () => {
    const reported = new Date('2026-10-11T07:59:30Z');
    expect(instantOf(reported, NOW)).toBe(reported);
    expect(instantOf(NOW, NOW)).toBe(NOW);
  });

  it('is now for a missing time and for one that claims to be ahead', () => {
    expect(instantOf(null, NOW)).toBe(NOW);
    expect(instantOf(new Date('2026-10-12T08:00:00Z'), NOW)).toBe(NOW);
  });
});

describe('routeContextOf', () => {
  it.each(['whatsapp', 'messenger', 'instagram'] as const)(
    'carries the account’s own platform for %s, so no service names it twice',
    (platform) => {
      expect(routeContextOf(contextOf({ platform }))).toEqual({
        tx,
        brandId: 'brand-1',
        account: {
          id: 'account-1',
          departmentId: 'dept-1',
          platform,
          externalId: '112233445566778',
        },
        now: NOW,
      });
    },
  );
});

describe('routeOrDrop', () => {
  const message = { externalId: 'mid.1' } as MetaInboundMessage;
  const routed = { kind: 'created', ticketId: 't', messageId: 'm', contactId: 'c' };

  const partsOf = (route: ReturnType<typeof vi.fn>) => {
    const log = logOf();
    return {
      log,
      parts: { router: { route }, sink: { store: vi.fn() }, log } as never,
    };
  };

  it('answers what the router filed, with the options it was given', async () => {
    const route = vi.fn(async () => routed);
    const { parts } = partsOf(route);

    await expect(
      routeOrDrop(parts, contextOf(), message, { fileRefusal: 'unreadable' }),
    ).resolves.toBe(routed);

    expect(route).toHaveBeenCalledWith(routeContextOf(contextOf()), message, expect.anything(), {
      fileRefusal: 'unreadable',
    });
  });

  it.each(['whatsapp', 'messenger', 'instagram'] as const)(
    'drops a %s customer id the contact layer refuses, and says so in a line without the id',
    async (platform) => {
      const route = vi.fn(async () => {
        throw new ContactFailure('identity-invalid', 'invalid-meta');
      });
      const { parts, log } = partsOf(route);

      await expect(routeOrDrop(parts, contextOf({ platform }), message)).resolves.toBeUndefined();

      expect(log.warn).toHaveBeenCalledExactlyOnceWith(
        { accountId: 'account-1', reason: 'identity-invalid' },
        `a ${platform} customer id was refused as an identifier; the message is dropped`,
      );
    },
  );

  it('does not swallow a failure that is not the contact layer’s', async () => {
    const { parts } = partsOf(
      vi.fn(async () => {
        throw new TypeError('a bug');
      }),
    );

    await expect(routeOrDrop(parts, contextOf(), message)).rejects.toThrow('a bug');
  });
});

describe('dropEcho', () => {
  const echo = (over: Partial<Extract<MetaEvent, { kind: 'echo' }>> = {}) =>
    ({
      kind: 'echo',
      platform: 'messenger',
      timestamp: null,
      customerId: '7654321098765432',
      messageId: 'mid.9',
      appId: null,
      metadata: null,
      text: '',
      ...over,
    }) as Extract<MetaEvent, { kind: 'echo' }>;
  const DELIVERY = '0196a1b2-0000-7000-8000-0000000000aa';

  const partsOf = (setup: { appId?: string; delivery?: { accountId: string } } = {}) => {
    const log = logOf();
    const repository = {
      delivery: vi.fn(async () => setup.delivery as never),
    };
    return {
      log,
      repository,
      parts: { appId: async () => setup.appId ?? '1234567890123456', repository, log },
    };
  };

  it('drops silently an echo that carries the install’s app id', async () => {
    const { parts, log } = partsOf();

    await expect(
      dropEcho(contextOf(), echo({ appId: '1234567890123456' }), parts),
    ).resolves.toEqual({ outcome: 'ignored', reason: 'own-echo' });
    expect(log.info).not.toHaveBeenCalled();
  });

  it('drops silently an echo whose metadata names a delivery of this account', async () => {
    const { parts, repository } = partsOf({ delivery: { accountId: 'account-1' } });

    await expect(
      dropEcho(contextOf(), echo({ appId: '42', metadata: DELIVERY }), parts),
    ).resolves.toEqual({ outcome: 'ignored', reason: 'own-echo' });
    expect(repository.delivery).toHaveBeenCalledWith(tx, DELIVERY);
  });

  it('counts an echo of a delivery that belongs to another account', async () => {
    const { parts, log } = partsOf({ delivery: { accountId: 'someone-else' } });

    await expect(
      dropEcho(contextOf(), echo({ appId: '42', metadata: DELIVERY }), parts),
    ).resolves.toEqual({ outcome: 'ignored', reason: 'foreign-echo' });
    expect(log.info).toHaveBeenCalledExactlyOnceWith(
      { accountId: 'account-1', platform: 'messenger' },
      'messenger echo of a message Helpdock did not send; dropped',
    );
  });

  it('counts an echo typed outside Helpdock, and never asks the database about a metadata that is not an id', async () => {
    const { parts, repository } = partsOf();

    await expect(
      dropEcho(
        contextOf({ platform: 'instagram' }),
        echo({ appId: '42', metadata: 'campaign-7' }),
        parts,
      ),
    ).resolves.toEqual({ outcome: 'ignored', reason: 'foreign-echo' });
    expect(repository.delivery).not.toHaveBeenCalled();
  });

  it('never takes an echo for the install’s by an app id when the install has none set', async () => {
    const { parts } = partsOf({ appId: '' });

    await expect(dropEcho(contextOf(), echo({ appId: null }), parts)).resolves.toEqual({
      outcome: 'ignored',
      reason: 'foreign-echo',
    });
  });
});

describe('askForProfile', () => {
  const unnamed = {
    profileName: null,
    username: null,
    profileCheckedAt: null,
  } as MetaConversation;

  it.each(['messenger', 'instagram'] as const)(
    'raises one lookup for a %s customer nobody has named, whose conversation is new',
    async (platform) => {
      await askForProfile(tx, account(platform), platform, 'conversation-1', undefined);

      expect(enqueueMetaProfile).toHaveBeenCalledExactlyOnceWith(tx, 'brand-1', {
        conversationId: 'conversation-1',
        accountId: 'account-1',
        platform,
      });
    },
  );

  it('asks again for a customer whose earlier lookup could not be answered', async () => {
    await askForProfile(tx, account(), 'messenger', 'conversation-1', unnamed);

    expect(enqueueMetaProfile).toHaveBeenCalledOnce();
  });

  it.each([
    ['a name', { profileName: 'Sheena Nelson' }],
    ['a handle', { username: 'sheena.n' }],
    ['an answer from Graph, however it came out', { profileCheckedAt: NOW }],
  ])('asks for nothing about a customer who already has %s', async (_what, facts) => {
    await askForProfile(tx, account(), 'messenger', 'c', { ...unnamed, ...facts });

    expect(enqueueMetaProfile).not.toHaveBeenCalled();
  });

  it.each(['token_expired', 'unsubscribed'] as const)(
    'asks for nothing on an account that is %s: it could not answer',
    async (status) => {
      await askForProfile(tx, { ...account(), status }, 'messenger', 'c', undefined);

      expect(enqueueMetaProfile).not.toHaveBeenCalled();
    },
  );
});

describe('otherEvent', () => {
  const base = { platform: 'messenger', timestamp: null } as const;

  it('counts the classifier’s own reason', () => {
    const log = logOf();
    const event: MetaEvent = { ...base, kind: 'ignored', reason: 'standby', detail: null };

    expect(otherEvent(log, contextOf(), event)).toEqual({ outcome: 'ignored', reason: 'standby' });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it.each(['postback', 'referral'] as const)('counts a %s under its own name', (kind) => {
    const event = {
      ...base,
      kind,
      customerId: '1',
      messageId: null,
      title: null,
      payload: null,
      source: null,
    } as MetaEvent;

    expect(otherEvent(logOf(), contextOf(), event)).toEqual({ outcome: 'ignored', reason: kind });
  });

  it('drops, and warns about, another platform’s vocabulary', () => {
    const log = logOf();
    const event: MetaEvent = {
      platform: 'instagram',
      timestamp: null,
      kind: 'seen',
      customerId: '1',
      messageId: 'mid.1',
    };

    expect(otherEvent(log, contextOf(), event)).toEqual({
      outcome: 'ignored',
      reason: 'wrong-platform',
    });
    expect(log.warn).toHaveBeenCalledExactlyOnceWith(
      { accountId: 'account-1', kind: 'seen', platform: 'instagram' },
      'messenger received an event of another platform; dropped',
    );
  });
});
