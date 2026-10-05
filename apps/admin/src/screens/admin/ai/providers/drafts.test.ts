import type { AiProviderKind, EmbeddingSettingsView } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import { changesSpace, embeddingDraftOf, embeddingRequestOf } from './embedding-draft.js';
import { draftOf, providerRequestOf } from './provider-draft.js';

const compatible: AiProviderKind = { id: 'openai-compatible', oauth: false, needsBaseUrl: true };
const openai: AiProviderKind = { id: 'openai', oauth: true, needsBaseUrl: false };

describe('providerRequestOf', () => {
  it('keeps a stored key when an edit leaves it alone', () => {
    const draft = draftOf({
      id: 'openai',
      kind: 'openai',
      label: 'OpenAI',
      baseUrl: null,
      authType: 'apiKey',
      oauthExpiresAt: null,
    });

    expect(providerRequestOf(draft, openai)).toEqual({
      ok: true,
      id: 'openai',
      request: { kind: 'openai', label: 'OpenAI', baseUrl: null, auth: { type: 'apiKey' } },
    });
  });

  it('names every field a new provider is missing', () => {
    const outcome = providerRequestOf(
      { ...draftOf(null), id: 'Local LLM', kind: 'openai-compatible' },
      compatible,
    );

    expect(outcome).toEqual({
      ok: false,
      problems: {
        id: 'idInvalid',
        label: 'labelRequired',
        baseUrl: 'baseUrlRequired',
        apiKey: 'apiKeyRequired',
      },
    });
  });

  it('takes subscription credentials only as the JSON pi-ai writes', () => {
    const base = { ...draftOf(null), id: 'claude', kind: 'anthropic', label: 'Claude' };

    expect(
      providerRequestOf({ ...base, authType: 'oauth', oauth: '{"access":"a"}' }, openai),
    ).toMatchObject({ ok: false, problems: { oauth: 'oauthInvalid' } });
    expect(
      providerRequestOf(
        { ...base, authType: 'oauth', oauth: '{"access":"a","refresh":"r","expires":1}' },
        openai,
      ),
    ).toMatchObject({
      ok: true,
      request: { auth: { type: 'oauth', credentials: { access: 'a', refresh: 'r', expires: 1 } } },
    });
  });
});

const stored: EmbeddingSettingsView = {
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  model: 'text-embedding-3-small',
  dims: 1536,
  pricePerMillionTokens: 0.02,
  hasApiKey: true,
  lockedKeys: [],
  space: {
    status: 'ready',
    activeModel: 'text-embedding-3-small',
    activeDims: 1536,
    targetModel: 'text-embedding-3-small',
    targetDims: 1536,
    lastError: null,
    startedAt: null,
    finishedAt: null,
    progress: { embedded: 10, total: 10 },
  },
};

describe('embeddingRequestOf', () => {
  it('refuses more than 2000 dimensions before the api is asked', () => {
    expect(embeddingRequestOf({ ...embeddingDraftOf(stored), dims: '3072' })).toEqual({
      ok: false,
      problems: { dims: 'dimsTooMany' },
    });
  });

  it('keeps the stored key, and says whether the change re-embeds', () => {
    const outcome = embeddingRequestOf({
      ...embeddingDraftOf(stored),
      model: 'text-embedding-3-large',
    });

    expect(outcome.ok && 'apiKey' in outcome.request).toBe(false);
    expect(outcome.ok && changesSpace(stored, outcome.request)).toBe(true);
    expect(changesSpace({ ...stored, model: '' }, { model: 'x', dims: 8 })).toBe(false);
  });
});
