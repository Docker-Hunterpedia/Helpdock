import { describe, expect, it } from 'vitest';
import { aiProviderConfigSchema, aiProvidersSchema } from './ai-providers.js';

const openai = {
  id: 'openai',
  kind: 'openai',
  label: 'OpenAI',
  baseUrl: null,
  auth: { type: 'apiKey', apiKey: 'sk-test' },
} as const;

describe('the ai.providers setting', () => {
  it('accepts the three kinds of credential and keeps what a provider adds to OAuth', () => {
    const oauth = {
      ...openai,
      id: 'claude-max',
      kind: 'anthropic',
      auth: {
        type: 'oauth',
        credentials: { access: 'a', refresh: 'r', expires: 1, enterpriseUrl: 'kept' },
      },
    };
    const local = {
      ...openai,
      id: 'ollama',
      kind: 'openai-compatible',
      baseUrl: 'http://ollama:11434/v1',
      auth: { type: 'none' },
    };

    const parsed = aiProvidersSchema.parse([openai, oauth, local]);

    expect(parsed[1]?.auth).toMatchObject({ credentials: { enterpriseUrl: 'kept' } });
  });

  it('needs a base URL for an OpenAI-compatible server', () => {
    expect(aiProviderConfigSchema.safeParse({ ...openai, kind: 'openai-compatible' }).success).toBe(
      false,
    );
  });

  it('refuses two providers with one id, and an id that is not a slug', () => {
    expect(aiProvidersSchema.safeParse([openai, openai]).success).toBe(false);
    expect(aiProviderConfigSchema.safeParse({ ...openai, id: 'Open AI' }).success).toBe(false);
  });

  it('refuses a base URL that is not http(s)', () => {
    expect(aiProviderConfigSchema.safeParse({ ...openai, baseUrl: 'file:///etc' }).success).toBe(
      false,
    );
  });
});
