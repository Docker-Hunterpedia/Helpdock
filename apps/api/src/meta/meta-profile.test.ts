import { GraphApiFailure, type GraphClient } from '@helpdock/channels';
import { describe, expect, it, vi } from 'vitest';
import { AccountGraph } from './account-graph.js';
import {
  contactNameFor,
  hasPlaceholderName,
  PROFILE_READS,
  parseProfile,
  planProfileLookup,
  readProfile,
  wantsProfile,
} from './meta-profile.js';

const TOKEN = 'IGQWRPbGl0ZXN0dG9rZW4xMjM0NTY3ODkw';
const CHECKED = new Date('2026-10-11T08:00:00Z');

const facts = (
  overrides: Partial<{
    profileName: string | null;
    username: string | null;
    profileCheckedAt: Date | null;
  }> = {},
) => ({ profileName: null, username: null, profileCheckedAt: null, ...overrides });

describe('wantsProfile', () => {
  it('wants the name of a customer nobody has named and Graph has not been asked about', () => {
    expect(wantsProfile(undefined)).toBe(true);
    expect(wantsProfile(facts())).toBe(true);
  });

  it.each([
    ['a name', facts({ profileName: 'Sheena Nelson' })],
    ['a handle', facts({ username: 'sheena.n' })],
    ['an answer, even a refusal', facts({ profileCheckedAt: CHECKED })],
  ])('wants nothing once there is %s', (_what, conversation) => {
    expect(wantsProfile(conversation)).toBe(false);
  });
});

describe('planProfileLookup', () => {
  const payload = { platform: 'instagram' } as const;
  const conversation = { ...facts(), accountId: 'account-1' };
  const account = { id: 'account-1', platform: 'instagram' } as const;

  it('reads for a conversation that wants it, and hands back the rows it checked', () => {
    expect(planProfileLookup(payload, conversation, account)).toEqual({
      read: true,
      conversation,
      account,
    });
  });

  it.each([
    ['the conversation is gone', undefined, account, 'conversation-gone'],
    ['the account is gone', conversation, undefined, 'account-gone'],
    [
      'the conversation is with another account',
      conversation,
      { ...account, id: 'other' },
      'wrong-account',
    ],
    [
      'the account is another platform',
      conversation,
      { ...account, platform: 'messenger' },
      'wrong-account',
    ],
    [
      'an earlier lookup answered',
      { ...conversation, profileCheckedAt: CHECKED },
      account,
      'answered',
    ],
    ['a name arrived another way', { ...conversation, profileName: 'Noor' }, account, 'answered'],
  ] as const)('does nothing when %s', (_what, row, owner, reason) => {
    expect(planProfileLookup(payload, row, owner)).toEqual({ read: false, reason });
  });
});

describe('what each platform is asked', () => {
  it('reads Instagram on the Instagram root and Messenger on the Facebook one', () => {
    expect(PROFILE_READS.instagram).toEqual({ api: 'instagram', fields: 'name,username' });
    expect(PROFILE_READS.messenger).toEqual({ api: 'graph', fields: 'first_name,last_name' });
  });
});

describe('parseProfile', () => {
  it('takes an Instagram name and handle', () => {
    expect(
      parseProfile('instagram', { id: '1', name: 'Sheena Nelson', username: 'sheena.n' }),
    ).toEqual({
      name: 'Sheena Nelson',
      username: 'sheena.n',
    });
  });

  it('joins a Messenger first and last name, and has no handle', () => {
    expect(parseProfile('messenger', { id: '1', first_name: 'Omar', last_name: 'Khalil' })).toEqual(
      {
        name: 'Omar Khalil',
        username: null,
      },
    );
    expect(parseProfile('messenger', { id: '1', first_name: 'Omar' })).toEqual({
      name: 'Omar',
      username: null,
    });
    expect(parseProfile('messenger', { id: '1', last_name: ' Khalil ' }).name).toBe('Khalil');
  });

  it('treats a blank as missing, and a handle Messenger would not send as none', () => {
    expect(parseProfile('instagram', { id: '1', name: '  ', username: '' })).toEqual({
      name: null,
      username: null,
    });
    expect(parseProfile('messenger', { id: '1', username: 'x', first_name: ' ' })).toEqual({
      name: null,
      username: null,
    });
  });

  it('refuses an answer that is not an object as a permanent failure, without the token', () => {
    expect(() => parseProfile('instagram', 'nope')).toThrow(GraphApiFailure);
    try {
      parseProfile('instagram', 'nope');
    } catch (error) {
      expect(error).toMatchObject({ kind: 'permanent' });
      expect(String(error)).not.toContain(TOKEN);
    }
  });
});

describe('readProfile', () => {
  const graphReturning = (body: unknown) => ({
    get: vi.fn<GraphClient['get']>(() => Promise.resolve(body)),
  });
  const graphFailing = (error: unknown) => ({
    get: vi.fn<GraphClient['get']>(() => Promise.reject(error)),
  });
  /** The client double behind an account's calls, which add the token and the platform's root. */
  const read = (
    client: Pick<GraphClient, 'get'>,
    platform: 'instagram' | 'messenger' = 'instagram',
  ) =>
    readProfile({
      graph: new AccountGraph(client as GraphClient, platform, TOKEN),
      platform,
      customerId: '1784',
    });

  it('asks on the platform’s root, for the platform’s fields, with the account’s token', async () => {
    const instagram = graphReturning({ id: '1784', name: 'Sheena', username: 'sheena.n' });
    const messenger = graphReturning({ id: '1784', first_name: 'Omar', last_name: 'Khalil' });

    expect(await read(instagram)).toEqual({
      kind: 'named',
      profile: { name: 'Sheena', username: 'sheena.n' },
    });
    expect(await read(messenger, 'messenger')).toEqual({
      kind: 'named',
      profile: { name: 'Omar Khalil', username: null },
    });
    expect(instagram.get).toHaveBeenCalledExactlyOnceWith('/1784', {
      token: TOKEN,
      api: 'instagram',
      query: { fields: 'name,username' },
    });
    expect(messenger.get).toHaveBeenCalledExactlyOnceWith('/1784', {
      token: TOKEN,
      api: 'graph',
      query: { fields: 'first_name,last_name' },
    });
  });

  it('is an answer with nothing in it when Graph sends neither', async () => {
    expect(await read(graphReturning({ id: '1784' }))).toEqual({ kind: 'empty' });
  });

  it.each([
    ['permission', 'refused'],
    ['permanent', 'refused'],
    ['account_restricted', 'refused'],
    ['window_closed', 'refused'],
    ['retry', 'retry'],
    ['rate_limited', 'retry'],
    ['token_dead', 'token_dead'],
  ] as const)('reads a %s failure as %s', async (failureKind, expected) => {
    const failure = new GraphApiFailure(failureKind, 'said no', { code: 10 });

    expect(await read(graphFailing(failure))).toEqual({ kind: expected, failure });
  });

  it('reads an answer in a shape it does not know as a refusal to record, not a failure to retry', async () => {
    expect(await read(graphReturning('not an object'))).toMatchObject({
      kind: 'refused',
      failure: { kind: 'permanent' },
    });
  });

  it('lets a bug propagate rather than call it an answer', async () => {
    await expect(read(graphFailing(new RangeError('a bug')))).rejects.toThrow(RangeError);
  });
});

describe('contactNameFor', () => {
  it('names the contact by the name, else by the @handle, else not at all', () => {
    expect(contactNameFor({ name: 'Sheena Nelson', username: 'sheena.n' })).toBe('Sheena Nelson');
    expect(contactNameFor({ name: null, username: 'sheena.n' })).toBe('@sheena.n');
    expect(contactNameFor({ name: null, username: null })).toBeNull();
  });
});

describe('hasPlaceholderName', () => {
  const identity = '17841400000000000:17841499999999999';

  it('is true for the name a contact gets when Meta gave none', () => {
    expect(hasPlaceholderName(identity, identity)).toBe(true);
    expect(hasPlaceholderName('', identity)).toBe(true);
    expect(hasPlaceholderName('  ', identity)).toBe(true);
  });

  it('is false for any name a person or Meta chose, an agent’s rename included', () => {
    expect(hasPlaceholderName('Sheena Nelson', identity)).toBe(false);
    expect(hasPlaceholderName('@sheena.n', identity)).toBe(false);
    expect(hasPlaceholderName(`${identity} (VIP)`, identity)).toBe(false);
  });
});
