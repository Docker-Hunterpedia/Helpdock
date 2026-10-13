import { GraphApiFailure } from '@helpdock/channels';
import { describe, expect, it } from 'vitest';
import { identifyWhatsApp, NO_BUSINESS_ACCOUNT_DETAIL } from './whatsapp-identity.js';

/**
 * Finding the business account of a WhatsApp number from the phone number id and
 * the token alone: the order of the calls, which business accounts are asked,
 * and what each answer means. A scripted Graph rather than the shared stand-in,
 * so each case says exactly what Meta answered.
 */

const NUMBER = '106540352242922';
const OTHER_NUMBER = '106540352242999';
const WABA = '102290129340398';
const OTHER_WABA = '102290129340111';

const number = {
  id: NUMBER,
  display_phone_number: '+1 555 0142',
  verified_name: 'Helpdock Support',
};

const debug = (
  granular: readonly { scope: string; target_ids?: readonly string[] }[],
  extra: Record<string, unknown> = {},
) => ({ data: { is_valid: true, expires_at: 0, granular_scopes: granular, ...extra } });

const numbersOf = (...ids: string[]) => ({ data: ids.map((id) => ({ id })), paging: {} });

const permissionRefused = () =>
  new GraphApiFailure('permission', '(#200) Requires whatsapp_business_management', { code: 200 });

/** Answers by path: a value is the body, an Error is thrown. */
const scripted = (answers: {
  readonly number?: unknown;
  readonly debug?: unknown;
  readonly numbers?: Readonly<Record<string, unknown>>;
}) => {
  const calls: string[] = [];
  const settle = (answer: unknown): unknown => {
    if (answer instanceof Error) {
      throw answer;
    }
    return answer;
  };

  return {
    calls,
    graph: {
      get: async (path: string): Promise<unknown> => {
        calls.push(path);
        if (path === `/${NUMBER}`) {
          return settle(answers.number ?? number);
        }
        const business = /^\/(\d+)\/phone_numbers$/.exec(path)?.[1];
        if (business !== undefined && answers.numbers?.[business] !== undefined) {
          return settle(answers.numbers[business]);
        }
        throw new GraphApiFailure('permanent', 'Unsupported get request', { code: 100 });
      },
      debugToken: async (): Promise<unknown> => {
        calls.push('debug_token');
        return settle(answers.debug);
      },
    },
  };
};

describe('identifyWhatsApp', () => {
  it('names the number, then finds the business account that lists it', async () => {
    const { graph, calls } = scripted({
      debug: debug([{ scope: 'whatsapp_business_management', target_ids: [WABA] }]),
      numbers: { [WABA]: numbersOf(OTHER_NUMBER, NUMBER) },
    });

    expect(await identifyWhatsApp(graph, NUMBER)).toEqual({
      ok: true,
      name: 'Helpdock Support',
      displayPhone: '+1 555 0142',
      expiresAt: null,
      wabaId: WABA,
    });
    expect(calls).toEqual([`/${NUMBER}`, 'debug_token', `/${WABA}/phone_numbers`]);
  });

  it('asks each business account the token was granted on until one lists the number', async () => {
    const { graph, calls } = scripted({
      debug: debug([{ scope: 'whatsapp_business_management', target_ids: [OTHER_WABA, WABA] }]),
      numbers: { [OTHER_WABA]: numbersOf(OTHER_NUMBER), [WABA]: numbersOf(NUMBER) },
    });

    expect(await identifyWhatsApp(graph, NUMBER)).toMatchObject({ ok: true, wabaId: WABA });
    expect(calls.slice(2)).toEqual([`/${OTHER_WABA}/phone_numbers`, `/${WABA}/phone_numbers`]);
  });

  it('stops at the first business account that lists it', async () => {
    const { graph, calls } = scripted({
      debug: debug([{ scope: 'whatsapp_business_management', target_ids: [WABA, OTHER_WABA] }]),
      numbers: { [WABA]: numbersOf(NUMBER) },
    });

    await identifyWhatsApp(graph, NUMBER);

    expect(calls).not.toContain(`/${OTHER_WABA}/phone_numbers`);
  });

  it('falls back to the messaging scope when management names no business account', async () => {
    const { graph } = scripted({
      debug: debug([
        { scope: 'whatsapp_business_management' },
        { scope: 'whatsapp_business_messaging', target_ids: [WABA] },
      ]),
      numbers: { [WABA]: numbersOf(NUMBER) },
    });

    expect(await identifyWhatsApp(graph, NUMBER)).toMatchObject({ ok: true, wabaId: WABA });
  });

  it('does not look past the management scope when it names business accounts', async () => {
    const { graph, calls } = scripted({
      debug: debug([
        { scope: 'whatsapp_business_management', target_ids: [OTHER_WABA] },
        { scope: 'whatsapp_business_messaging', target_ids: [WABA] },
      ]),
      numbers: { [OTHER_WABA]: numbersOf(OTHER_NUMBER), [WABA]: numbersOf(NUMBER) },
    });

    expect(await identifyWhatsApp(graph, NUMBER)).toMatchObject({
      ok: false,
      refusal: 'token-other-account',
    });
    expect(calls).not.toContain(`/${WABA}/phone_numbers`);
  });

  it('carries the end of a token that ends', async () => {
    const { graph } = scripted({
      debug: debug([{ scope: 'whatsapp_business_management', target_ids: [WABA] }], {
        expires_at: 1_792_000_000,
      }),
      numbers: { [WABA]: numbersOf(NUMBER) },
    });

    expect(await identifyWhatsApp(graph, NUMBER)).toMatchObject({
      expiresAt: new Date(1_792_000_000 * 1_000),
    });
  });

  it('refuses a token that names no business account, and says what to do', async () => {
    const { graph, calls } = scripted({ debug: debug([]) });

    expect(await identifyWhatsApp(graph, NUMBER)).toEqual({
      ok: false,
      refusal: 'token-other-account',
      detail: NO_BUSINESS_ACCOUNT_DETAIL,
    });
    expect(calls.some((call) => call.endsWith('/phone_numbers'))).toBe(false);
    expect(NO_BUSINESS_ACCOUNT_DETAIL).toMatch(/assign the business account to the system user/i);
  });

  it('refuses a token whose business accounts do not list the number', async () => {
    const { graph } = scripted({
      debug: debug([{ scope: 'whatsapp_business_management', target_ids: [OTHER_WABA] }]),
      numbers: { [OTHER_WABA]: numbersOf(OTHER_NUMBER) },
    });

    expect(await identifyWhatsApp(graph, NUMBER)).toMatchObject({
      ok: false,
      refusal: 'token-other-account',
    });
  });

  it('skips a business account the token may not list and goes on to the next', async () => {
    const { graph } = scripted({
      debug: debug([{ scope: 'whatsapp_business_management', target_ids: [OTHER_WABA, WABA] }]),
      numbers: { [OTHER_WABA]: permissionRefused(), [WABA]: numbersOf(NUMBER) },
    });

    expect(await identifyWhatsApp(graph, NUMBER)).toMatchObject({ ok: true, wabaId: WABA });
  });

  it('refuses, rather than failing, when every business account refuses to be listed', async () => {
    const { graph } = scripted({
      debug: debug([{ scope: 'whatsapp_business_management', target_ids: [WABA] }]),
      numbers: { [WABA]: permissionRefused() },
    });

    expect(await identifyWhatsApp(graph, NUMBER)).toMatchObject({
      ok: false,
      refusal: 'token-other-account',
    });
  });

  it.each([
    ['a rate limit', new GraphApiFailure('rate_limited', 'Too many calls', { code: 4 })],
    ['a server error', new GraphApiFailure('retry', 'Service unavailable', { status: 503 })],
    ['an answer in a shape nobody knows', { data: 'nonsense' }],
  ])(
    'throws on %s from a business account, which says nothing about the token',
    async (_, answer) => {
      const { graph } = scripted({
        debug: debug([{ scope: 'whatsapp_business_management', target_ids: [WABA] }]),
        numbers: { [WABA]: answer },
      });

      await expect(identifyWhatsApp(graph, NUMBER)).rejects.toBeInstanceOf(GraphApiFailure);
    },
  );

  it('refuses a token that opens a different number, before asking about the token', async () => {
    const { graph, calls } = scripted({ number: { id: OTHER_NUMBER }, debug: debug([]) });

    expect(await identifyWhatsApp(graph, NUMBER)).toEqual({
      ok: false,
      refusal: 'token-other-account',
      detail: null,
    });
    expect(calls).toEqual([`/${NUMBER}`]);
  });

  it('lets a token Graph calls dead be thrown for the caller to name', async () => {
    const { graph } = scripted({
      debug: new GraphApiFailure('token_dead', 'Error validating access token', { code: 190 }),
    });

    await expect(identifyWhatsApp(graph, NUMBER)).rejects.toMatchObject({ kind: 'token_dead' });
  });

  it('refuses a token its own check calls invalid, in Meta’s words', async () => {
    const { graph } = scripted({
      debug: { data: { is_valid: false, error: { code: 190, message: 'Session has expired' } } },
    });

    expect(await identifyWhatsApp(graph, NUMBER)).toEqual({
      ok: false,
      refusal: 'token-invalid',
      detail: 'Session has expired',
    });
  });

  it('says Graph failed, not that the token has no business account, when the check went unanswered', async () => {
    const { graph } = scripted({
      debug: new GraphApiFailure('retry', 'Service unavailable', { status: 503 }),
    });

    await expect(identifyWhatsApp(graph, NUMBER)).rejects.toMatchObject({ kind: 'retry' });
  });
});
