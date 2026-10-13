import { META_ERROR_MAX_LENGTH } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import {
  classifyGraphCode,
  classifyGraphError,
  describeGraphError,
  GRAPH_ERROR_CODES,
  GraphApiFailure,
  type GraphErrorKind,
  graphErrorFacts,
  isPermanentKind,
  redactToken,
  WINDOW_CLOSED_SUBCODE,
} from './errors.js';

const body = (code: number, message = 'Something', subcode?: number) => ({
  error: {
    message,
    type: 'OAuthException',
    code,
    ...(subcode === undefined ? {} : { error_subcode: subcode }),
    fbtrace_id: 'AbC123',
  },
});

describe('classifyGraphCode', () => {
  const table: readonly (readonly [GraphErrorKind, readonly number[]])[] = [
    ['token_dead', [190, 102, 463, 467, 0]],
    ['permission', [3, 10, 200, 250, 299]],
    ['window_closed', [131_047]],
    ['rate_limited', [4, 17, 32, 613, 130_429, 131_056, 80_007, 131_057]],
    ['retry', [1, 2, 131_000, 131_016]],
    ['account_restricted', [368, 131_031, 133_010, 131_042, 130_497]],
    [
      'permanent',
      [100, 551, 131_026, 131_049, 131_050, 131_051, 131_052, 131_053, 132_000, 132_012, 132_016],
    ],
  ];

  it.each(table.flatMap(([kind, codes]) => codes.map((code) => [code, kind] as const)))(
    'puts code %i in the %s class',
    (code, kind) => {
      expect(classifyGraphCode(code, null)).toBe(kind);
    },
  );

  it('reads code 10 with sub-code 2018278 as a closed window, and code 10 alone as a permission', () => {
    expect(classifyGraphCode(10, WINDOW_CLOSED_SUBCODE)).toBe('window_closed');
    expect(classifyGraphCode(10, null)).toBe('permission');
    expect(classifyGraphCode(10, 33)).toBe('permission');
  });

  it('does not let a sub-code reclassify any other code', () => {
    expect(classifyGraphCode(100, WINDOW_CLOSED_SUBCODE)).toBe('permanent');
    expect(classifyGraphCode(190, WINDOW_CLOSED_SUBCODE)).toBe('token_dead');
  });

  it('draws the edges of the permission range', () => {
    expect(classifyGraphCode(199, null)).toBe('permanent');
    expect(classifyGraphCode(200, null)).toBe('permission');
    expect(classifyGraphCode(299, null)).toBe('permission');
    expect(classifyGraphCode(300, null)).toBe('permanent');
  });

  it('treats a missing code as permanent, never as something to retry', () => {
    expect(classifyGraphCode(null, null)).toBe('permanent');
  });

  it('lists no code under two classes', () => {
    const seen = new Map<number, GraphErrorKind>();
    for (const kind of Object.keys(GRAPH_ERROR_CODES) as GraphErrorKind[]) {
      for (const code of GRAPH_ERROR_CODES[kind]) {
        expect(seen.get(code), `code ${String(code)}`).toBeUndefined();
        seen.set(code, kind);
      }
    }
  });
});

describe('classifyGraphError', () => {
  it('classifies by code and keeps the facts', () => {
    const failure = classifyGraphError(400, body(131_047, 'Re-engagement message'));

    expect(failure).toBeInstanceOf(GraphApiFailure);
    expect(failure).toMatchObject({
      kind: 'window_closed',
      code: 131_047,
      subcode: null,
      status: 400,
      permanent: true,
    });
    expect(failure.detail).toBe('131047: Re-engagement message');
  });

  it('shows the sub-code when there is one', () => {
    const failure = classifyGraphError(400, body(10, 'Outside the allowed window', 2_018_278));

    expect(failure.kind).toBe('window_closed');
    expect(failure.subcode).toBe(2_018_278);
    expect(failure.detail).toBe('10/2018278: Outside the allowed window');
  });

  it('prefers WhatsApp’s error_data details to the generic message', () => {
    const failure = classifyGraphError(400, {
      error: {
        message: '(#131056) Pair rate limit hit',
        code: 131_056,
        error_data: { messaging_product: 'whatsapp', details: 'Too many messages to this user' },
      },
    });

    expect(failure.detail).toBe('131056: Too many messages to this user');
    expect(failure.kind).toBe('rate_limited');
    expect(failure.permanent).toBe(false);
  });

  it.each([500, 502, 503, 504])('retries a %i whatever it quotes', (status) => {
    expect(classifyGraphError(status, null)).toMatchObject({ kind: 'retry', permanent: false });
    expect(classifyGraphError(status, body(100, 'Invalid parameter')).kind).toBe('retry');
  });

  it('falls back on the HTTP status when Graph gave no code', () => {
    expect(classifyGraphError(401, null).kind).toBe('token_dead');
    expect(classifyGraphError(403, '').kind).toBe('permission');
    expect(classifyGraphError(429, {}).kind).toBe('rate_limited');
    expect(classifyGraphError(404, null).kind).toBe('permanent');
    expect(classifyGraphError(400, 'not json').kind).toBe('permanent');
  });

  it('says which HTTP status when there is no code to quote', () => {
    expect(classifyGraphError(502, null).detail).toBe('HTTP 502: Graph gave no reason');
  });

  it('never puts the token in the detail, however Graph quoted it', () => {
    const token = 'EAAGm0PX4ZCpsBO1234567890abcdef';
    const failure = classifyGraphError(
      400,
      body(190, `Invalid OAuth access token ${token}; Bearer ${token}; access_token=${token}&x=1`),
      token,
    );

    expect(failure.detail).not.toContain(token);
    expect(failure.message).not.toContain(token);
    expect(failure.detail).toContain('<token>');
  });

  it('keeps the detail within what last_error stores', () => {
    const failure = classifyGraphError(400, body(100, 'x'.repeat(2_000)));

    expect(failure.detail.length).toBeLessThanOrEqual(META_ERROR_MAX_LENGTH);
    expect(failure.detail.endsWith('…')).toBe(true);
  });
});

describe('graphErrorFacts', () => {
  it('reads code, sub-code and message', () => {
    expect(graphErrorFacts(body(190, 'Expired', 463))).toEqual({
      code: 190,
      subcode: 463,
      message: 'Expired',
    });
  });

  it('answers null for a body that is not an error', () => {
    expect(graphErrorFacts({ id: '1' })).toBeNull();
    expect(graphErrorFacts(null)).toBeNull();
    expect(graphErrorFacts('error')).toBeNull();
    expect(graphErrorFacts({ error: 'plain text' })).toBeNull();
  });

  it('accepts an error with no code, as Graph sometimes sends', () => {
    expect(graphErrorFacts({ error: { message: 'Oops' } })).toEqual({
      code: null,
      subcode: null,
      message: 'Oops',
    });
  });
});

describe('describeGraphError', () => {
  it('names a missing message rather than printing undefined', () => {
    expect(describeGraphError({ code: 2, subcode: null, message: null }, 500)).toBe(
      '2: Graph gave no reason',
    );
  });
});

describe('isPermanentKind', () => {
  it('is false only for the two kinds a later attempt can fix', () => {
    const kinds: GraphErrorKind[] = [
      'retry',
      'rate_limited',
      'window_closed',
      'token_dead',
      'permission',
      'account_restricted',
      'permanent',
    ];

    expect(kinds.filter((kind) => !isPermanentKind(kind))).toEqual(['retry', 'rate_limited']);
  });
});

describe('redactToken', () => {
  it('removes a token that is quoted bare, in a header or in a query string', () => {
    const token = 'IGAAT0123456789abcdef';

    expect(redactToken(`bad ${token} here`, token)).toBe('bad <token> here');
    expect(redactToken('Authorization: Bearer abc.def-123')).toBe('Authorization: Bearer <token>');
    expect(redactToken('GET /me?access_token=abc123&fields=id')).toBe(
      'GET /me?access_token=<token>&fields=id',
    );
    expect(redactToken('?input_token=zzz999&client_secret=hush')).toBe(
      '?input_token=<token>&client_secret=<token>',
    );
  });

  it('leaves a token too short to be one alone, so ordinary words survive', () => {
    expect(redactToken('abc is fine', 'abc')).toBe('abc is fine');
  });
});
