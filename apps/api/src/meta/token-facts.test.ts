import { GraphApiFailure } from '@helpdock/channels';
import { META_ERROR_MAX_LENGTH } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import { readTokenFacts } from './token-facts.js';

const answering = (answer: unknown) => ({
  debugToken: async (): Promise<unknown> => {
    if (answer instanceof Error) {
      throw answer;
    }
    return answer;
  },
});

describe('readTokenFacts', () => {
  it('reads validity, the end of the token and where it was granted', async () => {
    const facts = await readTokenFacts(
      answering({
        data: {
          is_valid: true,
          expires_at: 1_792_000_000,
          granular_scopes: [
            { scope: 'whatsapp_business_management', target_ids: ['1', 2] },
            { scope: 'whatsapp_business_messaging', target_ids: ['1'] },
          ],
        },
      }),
    );

    expect(facts.valid).toBe(true);
    expect(facts.expiresAt).toEqual(new Date(1_792_000_000 * 1_000));
    expect(facts.detail).toBeNull();
    expect([...facts.targets]).toEqual([
      ['whatsapp_business_management', ['1', '2']],
      ['whatsapp_business_messaging', ['1']],
    ]);
  });

  it('reads zero as a token that does not end', async () => {
    const facts = await readTokenFacts(answering({ data: { is_valid: true, expires_at: 0 } }));

    expect(facts.expiresAt).toBeNull();
    expect(facts.targets.size).toBe(0);
  });

  it('merges a scope Graph lists twice without repeating an id', async () => {
    const facts = await readTokenFacts(
      answering({
        data: {
          is_valid: true,
          granular_scopes: [
            { scope: 'whatsapp_business_management', target_ids: ['1', '2'] },
            { scope: 'whatsapp_business_management', target_ids: ['2', '3'] },
          ],
        },
      }),
    );

    expect(facts.targets.get('whatsapp_business_management')).toEqual(['1', '2', '3']);
  });

  it('keeps what it can read when the granted scopes are in a shape it does not know', async () => {
    const facts = await readTokenFacts(
      answering({ data: { is_valid: true, granular_scopes: 'everything' } }),
    );

    expect(facts.valid).toBe(true);
    expect(facts.targets.size).toBe(0);
  });

  it('gives Graph’s reason for an invalid token, short', async () => {
    const facts = await readTokenFacts(
      answering({
        data: {
          is_valid: false,
          error: { code: 190, message: 'x'.repeat(META_ERROR_MAX_LENGTH * 2) },
        },
      }),
    );

    expect(facts.valid).toBe(false);
    expect(facts.detail).toHaveLength(META_ERROR_MAX_LENGTH);
  });

  it('throws a token Graph calls dead, because that was the question', async () => {
    await expect(
      readTokenFacts(answering(new GraphApiFailure('token_dead', 'Invalid OAuth', { code: 190 }))),
    ).rejects.toMatchObject({ kind: 'token_dead' });
  });

  it('throws a failure that is not Graph’s, which must not read as Graph not answering', async () => {
    await expect(readTokenFacts(answering(new TypeError('a bug of ours')))).rejects.toThrow(
      'a bug of ours',
    );
  });

  it.each([
    ['a failure that is no answer', new GraphApiFailure('retry', 'Unavailable', { status: 503 })],
    ['an answer in a shape nobody knows', { nonsense: true }],
  ])('says the question went unanswered on %s', async (_, answer) => {
    expect(await readTokenFacts(answering(answer))).toEqual({
      valid: null,
      expiresAt: null,
      detail: null,
      targets: new Map(),
    });
  });
});
