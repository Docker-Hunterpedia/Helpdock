import type { Settings } from '@helpdock/config';
import { describe, expect, it } from 'vitest';
import { resolveAiTarget } from './resolve-ai-target.js';

const settings = (values: {
  provider?: string;
  model?: string;
  providers?: readonly string[];
}): Pick<Settings, 'get'> =>
  ({
    get: async (key: string) =>
      ({
        'ai.defaultProvider': values.provider ?? '',
        'ai.defaultModel': values.model ?? '',
        'ai.providers': (values.providers ?? []).map((id) => ({ id })),
      })[key],
  }) as unknown as Pick<Settings, 'get'>;

describe('resolveAiTarget', () => {
  it('uses the install default when the brand names nothing', async () => {
    const target = await resolveAiTarget(
      undefined,
      settings({ provider: 'openai', model: 'gpt-4o-mini', providers: ['openai'] }),
    );

    expect(target).toMatchObject({ provider: { id: 'openai' }, modelId: 'gpt-4o-mini' });
  });

  it('prefers the brand’s own pair over the default', async () => {
    const target = await resolveAiTarget(
      { providerId: 'ollama', modelId: 'qwen3:8b' },
      settings({ provider: 'openai', model: 'gpt-4o-mini', providers: ['openai', 'ollama'] }),
    );

    expect(target).toMatchObject({ provider: { id: 'ollama' }, modelId: 'qwen3:8b' });
  });

  it('is undefined for a provider that is not on the install’s list', async () => {
    expect(
      await resolveAiTarget(undefined, settings({ provider: 'openai', model: 'm', providers: [] })),
    ).toBeUndefined();
  });

  it('is undefined without a model', async () => {
    expect(
      await resolveAiTarget(
        undefined,
        settings({ provider: 'openai', model: '', providers: ['openai'] }),
      ),
    ).toBeUndefined();
  });
});
