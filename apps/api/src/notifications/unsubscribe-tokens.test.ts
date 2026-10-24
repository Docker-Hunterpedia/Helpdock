import { createKeyring } from '@helpdock/config';
import { UNSUBSCRIBE_TOKEN_PATTERN } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import { CsatTokens } from '../csat/tokens.js';
import { UnsubscribeTokens, unsubscribeHeaders, unsubscribeLinks } from './unsubscribe-tokens.js';

const CURRENT = Buffer.alloc(32, 1).toString('base64');
const PREVIOUS = Buffer.alloc(32, 2).toString('base64');
const OLDER = Buffer.alloc(32, 3).toString('base64');

const USER = '0199f4b2-1111-7000-8000-000000000002';
const OTHER = '0199f4b2-1111-7000-8000-000000000003';
const ISSUED = new Date('2026-10-20T09:00:00.000Z');
const DAY = 86_400_000;

const tokensUnder = (current: string, previous?: string): UnsubscribeTokens =>
  new UnsubscribeTokens(
    createKeyring({
      APP_MASTER_KEY: current,
      ...(previous === undefined ? {} : { APP_MASTER_KEY_PREVIOUS: previous }),
    }),
  );

describe('UnsubscribeTokens', () => {
  it('signs a token of the shape the public route accepts and reads back whom it names', () => {
    const tokens = tokensUnder(CURRENT);
    const token = tokens.sign(USER, ISSUED);

    expect(token).toMatch(UNSUBSCRIBE_TOKEN_PATTERN);
    expect(tokens.verify(token, ISSUED)).toEqual({ userId: USER, issuedAt: ISSUED });
  });

  it('refuses a token whose user was swapped for another, keeping the MAC', () => {
    const tokens = tokensUnder(CURRENT);
    const [, mac] = tokens.sign(USER, ISSUED).split('.');
    const [otherPayload] = tokens.sign(OTHER, ISSUED).split('.');

    expect(tokens.verify(`${otherPayload}.${mac}`, ISSUED)).toBeNull();
  });

  it('refuses a token whose issue time was moved forward to outlive its year', () => {
    const tokens = tokensUnder(CURRENT);
    const [, mac] = tokens.sign(USER, ISSUED).split('.');
    const [later] = tokens.sign(USER, new Date(ISSUED.getTime() + 400 * DAY)).split('.');

    expect(tokens.verify(`${later}.${mac}`, new Date(ISSUED.getTime() + 400 * DAY))).toBeNull();
  });

  it('has one spelling: the unused bits of each half’s last character cannot be changed', () => {
    const tokens = tokensUnder(CURRENT);
    const token = tokens.sign(USER, ISSUED);
    const [payload = '', mac = ''] = token.split('.');
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    // Same leading bits, different spare ones: each half leaves 2 (160 and 256 bits in 162 and 258).
    const respelled = (half: string, spare: number): string[] => {
      const last = alphabet.indexOf(half.slice(-1));
      const base = last - (last % 2 ** spare);

      return Array.from({ length: 2 ** spare }, (_, bits) => alphabet[base + bits] ?? '')
        .filter((char) => char !== half.slice(-1))
        .map((char) => `${half.slice(0, -1)}${char}`);
    };
    const payloads = respelled(payload, 2);
    const macs = respelled(mac, 2);

    expect(payloads).toHaveLength(3);
    expect(macs).toHaveLength(3);
    expect(tokens.verify(token, ISSUED)).not.toBeNull();
    for (const other of payloads) {
      expect(tokens.verify(`${other}.${mac}`, ISSUED)).toBeNull();
    }
    for (const other of macs) {
      expect(tokens.verify(`${payload}.${other}`, ISSUED)).toBeNull();
    }
  });

  it('refuses a token signed under a key this install does not hold', () => {
    expect(tokensUnder(CURRENT).verify(tokensUnder(OLDER).sign(USER, ISSUED), ISSUED)).toBeNull();
  });

  it('still accepts a link signed under the key being rotated away from', () => {
    const before = tokensUnder(PREVIOUS).sign(USER, ISSUED);

    expect(tokensUnder(CURRENT, PREVIOUS).verify(before, ISSUED)?.userId).toBe(USER);
  });

  it('is bound to its purpose: a CSAT token never verifies, and ours is no CSAT token', () => {
    const csat = new CsatTokens(createKeyring({ APP_MASTER_KEY: CURRENT }));
    const csatToken = csat.sign({ brandId: USER, surveyId: OTHER });

    expect(tokensUnder(CURRENT).verify(csatToken, ISSUED)).toBeNull();
    expect(csat.verify(tokensUnder(CURRENT).sign(USER, ISSUED))).toBeNull();
  });

  describe('lifetime', () => {
    it('is good for a year and a second less, and not for the year', () => {
      const tokens = tokensUnder(CURRENT);
      const token = tokens.sign(USER, ISSUED);

      expect(tokens.verify(token, new Date(ISSUED.getTime() + 365 * DAY - 1000))).not.toBeNull();
      expect(tokens.verify(token, new Date(ISSUED.getTime() + 365 * DAY))).toBeNull();
      expect(tokens.verify(token, new Date(ISSUED.getTime() + 500 * DAY))).toBeNull();
    });

    it('forgives a few minutes of clock difference, and not a token from the future', () => {
      const tokens = tokensUnder(CURRENT);
      const token = tokens.sign(USER, ISSUED);

      expect(tokens.verify(token, new Date(ISSUED.getTime() - 4 * 60_000))).not.toBeNull();
      expect(tokens.verify(token, new Date(ISSUED.getTime() - 6 * 60_000))).toBeNull();
    });
  });

  it.each([
    ['empty', ''],
    ['one half', 'AAAAAAAAAAAAAAAAAAAAAAAAAAA'],
    [
      'three parts',
      'AAAAAAAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.x',
    ],
    ['wrong lengths', 'AAAA.BBBB'],
    ['not base64url', `${'!'.repeat(27)}.${'!'.repeat(43)}`],
    ['the right shape, zeroes', `${'A'.repeat(27)}.${'A'.repeat(43)}`],
  ])('refuses a token that is %s', (_name, token) => {
    expect(tokensUnder(CURRENT).verify(token, ISSUED)).toBeNull();
  });
});

describe('unsubscribeLinks', () => {
  it('names the confirmation page for people and the api address for mail clients', () => {
    const tokens = tokensUnder(CURRENT);
    const links = unsubscribeLinks(tokens, 'https://desk.example.com', USER, 'ar', ISSUED);
    const token = tokens.sign(USER, ISSUED);

    expect(links.page).toBe(`https://desk.example.com/unsubscribe/${token}?lang=ar`);
    expect(links.oneClick).toBe(`https://desk.example.com/api/public/unsubscribe/${token}`);
  });

  it('is the RFC 8058 header pair, over https', () => {
    const headers = unsubscribeHeaders({
      page: 'https://desk.example.com/unsubscribe/t',
      oneClick: 'https://desk.example.com/api/public/unsubscribe/t',
    });

    expect(headers).toEqual({
      'List-Unsubscribe': '<https://desk.example.com/api/public/unsubscribe/t>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
  });
});
