import { createHmac } from 'node:crypto';
import { META_SIGNATURE_HEADER } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import { hubChallenge, hubSignature, verifyHubSignature } from './signature.js';

const SECRET = 'app-secret-0123456789abcdef';
const INSTAGRAM_SECRET = 'instagram-secret-fedcba9876543210';
const BODY = Buffer.from(
  JSON.stringify({ object: 'page', entry: [{ id: '106540352242922', messaging: [] }] }),
);

describe('hubSignature', () => {
  it('is sha256= and the hex HMAC of the raw bytes, as Meta writes it', () => {
    const expected = createHmac('sha256', SECRET).update(BODY).digest('hex');

    expect(hubSignature(BODY, SECRET)).toBe(`sha256=${expected}`);
  });

  it('names the header in lower case, where Fastify keeps it', () => {
    expect(META_SIGNATURE_HEADER).toBe('x-hub-signature-256');
  });
});

describe('verifyHubSignature', () => {
  it('accepts the signature of the body under the secret', () => {
    expect(verifyHubSignature(BODY, hubSignature(BODY, SECRET), [SECRET])).toBe(true);
  });

  it('accepts either of two secrets, the second as readily as the first', () => {
    const secrets = [SECRET, INSTAGRAM_SECRET];

    expect(verifyHubSignature(BODY, hubSignature(BODY, SECRET), secrets)).toBe(true);
    expect(verifyHubSignature(BODY, hubSignature(BODY, INSTAGRAM_SECRET), secrets)).toBe(true);
  });

  it('refuses a signature made with a secret that is not one of them', () => {
    expect(verifyHubSignature(BODY, hubSignature(BODY, 'someone-elses-secret'), [SECRET])).toBe(
      false,
    );
  });

  it('refuses a tampered body: one byte changed after signing', () => {
    const header = hubSignature(BODY, SECRET);
    const tampered = Buffer.from(BODY);
    tampered[tampered.length - 3] = (tampered[tampered.length - 3] ?? 0) ^ 1;

    expect(verifyHubSignature(tampered, header, [SECRET])).toBe(false);
  });

  it('refuses a body that was re-serialised, because only the raw bytes were signed', () => {
    const header = hubSignature(BODY, SECRET);
    const reserialised = Buffer.from(JSON.stringify(JSON.parse(BODY.toString('utf8')), null, 2));

    expect(verifyHubSignature(reserialised, header, [SECRET])).toBe(false);
  });

  it.each([
    ['no header', undefined],
    ['an empty header', ''],
    ['the wrong scheme', `sha1=${'a'.repeat(40)}`],
    ['no scheme', 'a'.repeat(64)],
    ['a digest one byte short', `sha256=${'a'.repeat(62)}`],
    ['a digest one byte long', `sha256=${'a'.repeat(66)}`],
    ['digits that are not hex', `sha256=${'z'.repeat(64)}`],
  ])('refuses %s', (_label, header) => {
    expect(verifyHubSignature(BODY, header, [SECRET])).toBe(false);
  });

  it('reads the hex in either case and ignores whitespace around the header', () => {
    const header = hubSignature(BODY, SECRET);

    expect(
      verifyHubSignature(BODY, header.toUpperCase().replace('SHA256=', 'sha256='), [SECRET]),
    ).toBe(true);
    expect(verifyHubSignature(BODY, `  ${header}\n`, [SECRET])).toBe(true);
  });

  it('never matches on an empty secret, which anybody could sign with', () => {
    expect(verifyHubSignature(BODY, hubSignature(BODY, ''), [''])).toBe(false);
    expect(verifyHubSignature(BODY, hubSignature(BODY, ''), ['', ''])).toBe(false);
    // And an empty secret beside a real one changes nothing for the real one.
    expect(verifyHubSignature(BODY, hubSignature(BODY, SECRET), ['', SECRET])).toBe(true);
    expect(verifyHubSignature(BODY, hubSignature(BODY, ''), ['', SECRET])).toBe(false);
  });

  it('refuses everything when the install has no secret at all', () => {
    expect(verifyHubSignature(BODY, hubSignature(BODY, SECRET), [])).toBe(false);
  });
});

describe('hubChallenge', () => {
  const query = {
    'hub.mode': 'subscribe',
    'hub.verify_token': 'verify-me-0123456789',
    'hub.challenge': '1158201444',
  };

  it('echoes the challenge when the mode and the token are right', () => {
    expect(hubChallenge(query, 'verify-me-0123456789')).toBe('1158201444');
  });

  it('reads a query a parser nested as hub: { mode, … }', () => {
    expect(
      hubChallenge(
        { hub: { mode: 'subscribe', verify_token: 'verify-me-0123456789', challenge: '42' } },
        'verify-me-0123456789',
      ),
    ).toBe('42');
  });

  it('takes the first value of a parameter repeated in the query string', () => {
    expect(hubChallenge({ ...query, 'hub.challenge': ['7', '8'] }, 'verify-me-0123456789')).toBe(
      '7',
    );
  });

  it('refuses a wrong token, a wrong mode, and a missing parameter', () => {
    expect(
      hubChallenge({ ...query, 'hub.verify_token': 'nope' }, 'verify-me-0123456789'),
    ).toBeNull();
    expect(
      hubChallenge({ ...query, 'hub.mode': 'unsubscribe' }, 'verify-me-0123456789'),
    ).toBeNull();
    expect(hubChallenge({ ...query, 'hub.mode': undefined }, 'verify-me-0123456789')).toBeNull();
    expect(
      hubChallenge({ ...query, 'hub.verify_token': undefined }, 'verify-me-0123456789'),
    ).toBeNull();
    expect(
      hubChallenge({ ...query, 'hub.challenge': undefined }, 'verify-me-0123456789'),
    ).toBeNull();
    expect(hubChallenge({}, 'verify-me-0123456789')).toBeNull();
  });

  it('refuses a token that is a prefix of the real one, or longer than it', () => {
    expect(
      hubChallenge({ ...query, 'hub.verify_token': 'verify-me' }, 'verify-me-0123456789'),
    ).toBeNull();
    expect(
      hubChallenge(
        { ...query, 'hub.verify_token': 'verify-me-0123456789x' },
        'verify-me-0123456789',
      ),
    ).toBeNull();
  });

  it('answers nobody while the install has no verify token, even one sent empty', () => {
    expect(hubChallenge({ ...query, 'hub.verify_token': '' }, '')).toBeNull();
    expect(hubChallenge(query, '')).toBeNull();
  });

  it('refuses a challenge that is empty, too long, or not plain printable text', () => {
    expect(hubChallenge({ ...query, 'hub.challenge': '' }, 'verify-me-0123456789')).toBeNull();
    expect(
      hubChallenge({ ...query, 'hub.challenge': '9'.repeat(257) }, 'verify-me-0123456789'),
    ).toBeNull();
    expect(
      hubChallenge({ ...query, 'hub.challenge': 'a\r\nSet-Cookie: x' }, 'verify-me-0123456789'),
    ).toBeNull();
    expect(hubChallenge({ ...query, 'hub.challenge': 'é' }, 'verify-me-0123456789')).toBeNull();
  });

  it('accepts a challenge of exactly 256 characters', () => {
    expect(
      hubChallenge({ ...query, 'hub.challenge': '9'.repeat(256) }, 'verify-me-0123456789'),
    ).toBe('9'.repeat(256));
  });
});
