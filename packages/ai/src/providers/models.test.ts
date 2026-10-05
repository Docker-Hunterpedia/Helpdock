import type { AiProviderConfig } from '@helpdock/config';
import { describe, expect, it } from 'vitest';
import { AiHttpError } from '../http.js';
import { fakeEmbeddingsServer } from '../testing.js';
import { listModels, ModelNotFoundError, providerKinds, resolveModel } from './models.js';

const openai: AiProviderConfig = {
  id: 'openai',
  kind: 'openai',
  label: 'OpenAI',
  baseUrl: null,
  auth: { type: 'apiKey', apiKey: 'sk-test' },
};

const ollama: AiProviderConfig = {
  id: 'ollama',
  kind: 'openai-compatible',
  label: 'Ollama',
  baseUrl: 'http://ollama:11434/v1',
  auth: { type: 'none' },
};

const noNetwork = () =>
  Promise.reject(new Error('a built-in provider must not be asked over HTTP'));

describe('provider kinds', () => {
  it("lists pi-ai's built-ins, marks the subscription ones, and adds openai-compatible last", () => {
    const kinds = providerKinds();

    expect(kinds.find((kind) => kind.id === 'openai')).toEqual({
      id: 'openai',
      oauth: false,
      needsBaseUrl: false,
    });
    expect(kinds.find((kind) => kind.id === 'anthropic')?.oauth).toBe(true);
    expect(kinds.at(-1)).toEqual({ id: 'openai-compatible', oauth: false, needsBaseUrl: true });
  });
});

describe('model discovery', () => {
  it("reads a built-in provider's models and prices from pi-ai's registry, without a request", async () => {
    const models = await listModels(openai, noNetwork);

    expect(models.find((model) => model.id === 'gpt-4o-mini')).toMatchObject({
      inputPerMillionUsd: 0.15,
      outputPerMillionUsd: 0.6,
    });
  });

  it('asks an OpenAI-compatible server for its models', async () => {
    const server = fakeEmbeddingsServer(4, ['qwen3:8b', 'llama3.1:8b']);

    const models = await listModels(ollama, server.http);

    expect(models.map((model) => model.id)).toEqual(['llama3.1:8b', 'qwen3:8b']);
    expect(server.requests[0]?.url).toBe('http://ollama:11434/v1/models');
  });

  it('reports a server that refuses the listing', async () => {
    const server = fakeEmbeddingsServer(4);
    server.failWith(401);

    await expect(listModels(ollama, server.http)).rejects.toBeInstanceOf(AiHttpError);
  });

  it('lists nothing for a kind pi-ai does not know', async () => {
    await expect(listModels({ ...openai, kind: 'nonexistent' }, noNetwork)).resolves.toEqual([]);
  });
});

describe('resolving a model', () => {
  it('takes a built-in model from the registry and swaps in a configured base URL', () => {
    expect(resolveModel(openai, 'gpt-4o-mini')).toMatchObject({
      provider: 'openai',
      api: 'openai-responses',
    });
    expect(
      resolveModel({ ...openai, baseUrl: 'https://gateway.example.com/v1' }, 'gpt-4o-mini').baseUrl,
    ).toBe('https://gateway.example.com/v1');
  });

  it('describes an OpenAI-compatible model as a chat-completions model at its base URL, priced at zero', () => {
    expect(resolveModel(ollama, 'qwen3:8b')).toMatchObject({
      id: 'qwen3:8b',
      api: 'openai-completions',
      baseUrl: 'http://ollama:11434/v1',
      cost: { input: 0, output: 0 },
    });
  });

  it('refuses a model the provider does not offer', () => {
    expect(() => resolveModel(openai, 'gpt-0')).toThrow(ModelNotFoundError);
    expect(() => resolveModel({ ...openai, kind: 'nonexistent' }, 'x')).toThrow(ModelNotFoundError);
  });
});
