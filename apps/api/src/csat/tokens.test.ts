import { createKeyring } from '@helpdock/config';
import { CSAT_TOKEN_PATTERN } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import { CsatTokens, hashCsatToken } from './tokens.js';

const CURRENT = Buffer.alloc(32, 1).toString('base64');
const PREVIOUS = Buffer.alloc(32, 2).toString('base64');
const OLDER = Buffer.alloc(32, 3).toString('base64');

const SUBJECT = {
  brandId: '0199f4b2-0000-7000-8000-0000000000b1',
  surveyId: '0199f4b2-1111-7000-8000-00000000c5a7',
};

const tokensUnder = (current: string, previous?: string): CsatTokens =>
  new CsatTokens(
    createKeyring({
      APP_MASTER_KEY: current,
      ...(previous === undefined ? {} : { APP_MASTER_KEY_PREVIOUS: previous }),
    }),
  );

describe('CsatTokens', () => {
  it('signs a token of the shape the public route accepts', () => {
    expect(tokensUnder(CURRENT).sign(SUBJECT)).toMatch(CSAT_TOKEN_PATTERN);
  });

  it('reads back the brand and survey it names', () => {
    const tokens = tokensUnder(CURRENT);

    expect(tokens.verify(tokens.sign(SUBJECT))).toEqual(SUBJECT);
  });

  it('signs the same subject the same way, so the agent’s link can be recomputed', () => {
    expect(tokensUnder(CURRENT).sign(SUBJECT)).toBe(tokensUnder(CURRENT).sign(SUBJECT));
  });

  it('refuses a token whose ids were changed to reach another survey', () => {
    const tokens = tokensUnder(CURRENT);
    const [, mac] = tokens.sign(SUBJECT).split('.');
    const [otherIds] = tokens.sign({ ...SUBJECT, surveyId: SUBJECT.brandId }).split('.');

    expect(tokens.verify(`${otherIds}.${mac}`)).toBeNull();
  });

  it('refuses a token signed under a key this install does not hold', () => {
    expect(tokensUnder(CURRENT).verify(tokensUnder(OLDER).sign(SUBJECT))).toBeNull();
  });

  it('still accepts a link signed under the key being rotated away from', () => {
    const before = tokensUnder(PREVIOUS).sign(SUBJECT);

    expect(tokensUnder(CURRENT, PREVIOUS).verify(before)).toEqual(SUBJECT);
  });

  it('offers the current key’s token first among the candidates', () => {
    const rotated = tokensUnder(CURRENT, PREVIOUS);

    expect(rotated.candidates(SUBJECT)).toEqual([
      tokensUnder(CURRENT).sign(SUBJECT),
      tokensUnder(PREVIOUS).sign(SUBJECT),
    ]);
  });

  it.each([
    ['no separator', 'abc'],
    ['three parts', 'a.b.c'],
    ['ids of the wrong length', `${Buffer.alloc(8).toString('base64url')}.${'A'.repeat(43)}`],
    ['a mac of the wrong length', `${Buffer.alloc(32).toString('base64url')}.AAAA`],
  ])('refuses %s', (_label, token) => {
    expect(tokensUnder(CURRENT).verify(token)).toBeNull();
  });
});

describe('hashCsatToken', () => {
  it('is the hex SHA-256 the table stores, and not the token', () => {
    const token = tokensUnder(CURRENT).sign(SUBJECT);

    expect(hashCsatToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashCsatToken(token)).not.toContain(token);
  });
});
