import { describe, expect, it } from 'vitest';
import {
  AI_CALLS_PAGE_SIZE,
  AI_DEFAULT_THRESHOLD,
  aiProviderUpsertSchema,
  brandAiCallsQuerySchema,
  brandAiPromptUpdateSchema,
  brandAiSettingsUpdateSchema,
  EMBEDDING_MAX_DIMS,
  embeddingSettingsUpdateSchema,
  parseAiAssistantModes,
  transcriptionSettingsUpdateSchema,
} from './ai.js';

describe('aiProviderUpsertSchema', () => {
  it('accepts an API key, OAuth credentials, or no credential at all', () => {
    const base = { kind: 'openai', label: 'OpenAI', baseUrl: null };

    expect(
      aiProviderUpsertSchema.safeParse({ ...base, auth: { type: 'apiKey', apiKey: 'sk' } }).success,
    ).toBe(true);
    expect(
      aiProviderUpsertSchema.safeParse({
        ...base,
        auth: { type: 'oauth', credentials: { access: 'a', refresh: 'r', expires: 1 } },
      }).success,
    ).toBe(true);
    expect(aiProviderUpsertSchema.safeParse({ ...base, auth: { type: 'apiKey' } }).success).toBe(
      true,
    );
    expect(aiProviderUpsertSchema.safeParse({ ...base, auth: { type: 'none' } }).success).toBe(
      true,
    );
  });

  it('refuses an unknown field, so a typo cannot be silently ignored', () => {
    expect(
      aiProviderUpsertSchema.safeParse({
        kind: 'openai',
        label: 'OpenAI',
        baseUrl: null,
        auth: { type: 'apiKey', key: 'sk' },
      }).success,
    ).toBe(false);
  });
});

describe('embeddingSettingsUpdateSchema', () => {
  const body = {
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'text-embedding-3-small',
    dims: 1536,
    pricePerMillionTokens: 0.02,
  };

  it('accepts a model at or below the index ceiling', () => {
    expect(
      embeddingSettingsUpdateSchema.safeParse({ ...body, dims: EMBEDDING_MAX_DIMS }).success,
    ).toBe(true);
  });

  it('refuses a model above 2000 dimensions with the reason (ADR 0005)', () => {
    const result = embeddingSettingsUpdateSchema.safeParse({ ...body, dims: 3072 });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/at most 2000 dimensions/);
  });
});

describe('brandAiSettingsUpdateSchema', () => {
  const body = {
    providerId: 'openai',
    modelId: 'gpt-4o-mini',
    injectionFilter: true,
    budget: { dailyUsd: 5, monthlyUsd: null },
  };

  it('has no PII redaction toggle: redaction runs before every call', () => {
    expect(brandAiSettingsUpdateSchema.safeParse({ ...body, piiRedaction: false }).success).toBe(
      false,
    );
  });

  it('takes a provider and a model together, or neither', () => {
    expect(brandAiSettingsUpdateSchema.safeParse(body).success).toBe(true);
    expect(
      brandAiSettingsUpdateSchema.safeParse({ ...body, providerId: null, modelId: null }).success,
    ).toBe(true);
    expect(brandAiSettingsUpdateSchema.safeParse({ ...body, modelId: null }).success).toBe(false);
  });

  it('refuses a budget of zero, which would be a hard stop nobody asked for', () => {
    expect(
      brandAiSettingsUpdateSchema.safeParse({ ...body, budget: { dailyUsd: 0, monthlyUsd: null } })
        .success,
    ).toBe(false);
  });
});

describe('brandAiPromptUpdateSchema', () => {
  it('caps the system prompt', () => {
    expect(brandAiPromptUpdateSchema.safeParse({ systemPrompt: 'x'.repeat(8_001) }).success).toBe(
      false,
    );
  });
});

describe('parseAiAssistantModes', () => {
  it('reads a row with no modes as every mode off', () => {
    const modes = parseAiAssistantModes(null);

    expect(modes.agentAssist).toBe(false);
    expect(modes.autoReply.widget).toEqual({ enabled: false, threshold: AI_DEFAULT_THRESHOLD });
    expect(modes.keepAssistAfterHardStop).toBe(true);
  });

  it('fills a channel a stored row predates with its default', () => {
    const modes = parseAiAssistantModes({
      autoReply: { widget: { enabled: true, threshold: 0.9 } },
    });

    expect(modes.autoReply.widget).toEqual({ enabled: true, threshold: 0.9 });
    expect(modes.autoReply.telegram.enabled).toBe(false);
  });
});

describe('brandAiCallsQuerySchema', () => {
  it('pages by twenty and caps a page at a hundred', () => {
    expect(brandAiCallsQuerySchema.parse({}).limit).toBe(AI_CALLS_PAGE_SIZE);
    expect(brandAiCallsQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
  });
});

describe('transcriptionSettingsUpdateSchema', () => {
  it('takes an http(s) endpoint, or an empty one, which turns transcription off', () => {
    const base = { model: 'whisper-1' };

    expect(transcriptionSettingsUpdateSchema.safeParse({ ...base, endpoint: '' }).success).toBe(
      true,
    );
    expect(
      transcriptionSettingsUpdateSchema.safeParse({ ...base, endpoint: 'ftp://x.test/a' }).success,
    ).toBe(false);
  });
});
