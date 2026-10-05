import { describe, expect, it } from 'vitest';
import { EMBED_BATCH_SIZE, EmbeddingDimensionError } from './embed.js';
import { AiHttpError } from './http.js';
import { createAi } from './index.js';
import { type EmbeddingConfig, EmbeddingNotConfiguredError } from './ports.js';
import { fakeEmbeddingsServer, fakeVector, InMemoryAiPorts } from './testing.js';

const brandId = '0192f4d2-0000-7000-8000-000000000001';

const config: EmbeddingConfig = {
  provider: 'openai',
  baseUrl: 'https://embeddings.example.com/v1/',
  apiKey: 'sk-embed',
  model: 'fake-embedding',
  dims: 8,
  pricePerMillionTokens: 2,
};

const setup = (dims = 8, embedding: EmbeddingConfig | null = config) => {
  const server = fakeEmbeddingsServer(dims);
  const ports = new InMemoryAiPorts({ embedding });
  return { server, ports, ai: createAi({ ports, http: server.http }) };
};

describe('embed()', () => {
  it('posts to the OpenAI-compatible endpoint and returns one vector per text, in order', async () => {
    const { server, ai } = setup();

    const result = await ai.embed({ brandId, feature: 'knowledge.embed', texts: ['a', 'b'] });

    expect(result).toEqual({
      vectors: [fakeVector('a', 8), fakeVector('b', 8)],
      model: 'fake-embedding',
      dims: 8,
    });
    expect(server.requests[0]?.url).toBe('https://embeddings.example.com/v1/embeddings');
    expect(server.requests[0]?.request.headers.authorization).toBe('Bearer sk-embed');
  });

  it('logs each request with its tokens and its cost at the configured price, without the texts', async () => {
    const { ports, ai } = setup();

    await ai.embed({ brandId, feature: 'knowledge.embed', texts: ['refunds', 'returns'] });

    expect(ports.calls).toEqual([
      expect.objectContaining({
        feature: 'knowledge.embed',
        provider: 'openai',
        model: 'fake-embedding',
        status: 'ok',
        tokensIn: 'refunds returns'.length,
        costUsd: ('refunds returns'.length * 2) / 1e6,
        prompt: null,
        response: null,
      }),
    ]);
  });

  it('redacts PII from the texts it sends', async () => {
    const { server, ai } = setup();

    await ai.embed({ brandId, feature: 'retrieval.query', texts: ['my email is a@example.com'] });

    expect(server.requests[0]?.request.body).toContain('[EMAIL_1]');
    expect(server.requests[0]?.request.body).not.toContain('a@example.com');
  });

  it('splits a long list into batches', async () => {
    const { server, ai } = setup();
    const texts = Array.from({ length: EMBED_BATCH_SIZE + 1 }, (_, index) => `text ${index}`);

    const result = await ai.embed({ brandId, feature: 'knowledge.embed', texts });

    expect(server.requests).toHaveLength(2);
    expect(result.vectors).toHaveLength(texts.length);
  });

  it('refuses vectors of a dimension other than the configured one', async () => {
    const { ports, ai } = setup(12);

    await expect(
      ai.embed({ brandId, feature: 'knowledge.embed', texts: ['a'] }),
    ).rejects.toBeInstanceOf(EmbeddingDimensionError);
    expect(ports.calls[0]?.status).toBe('error');
  });

  it('logs and rethrows an HTTP failure', async () => {
    const { server, ports, ai } = setup();
    server.failWith(503);

    await expect(
      ai.embed({ brandId, feature: 'knowledge.embed', texts: ['a'] }),
    ).rejects.toBeInstanceOf(AiHttpError);
    expect(ports.calls[0]).toMatchObject({
      status: 'error',
      error: expect.stringContaining('503'),
    });
  });

  it('throws EmbeddingNotConfiguredError before the install has a model', async () => {
    const { ai } = setup(8, null);

    await expect(
      ai.embed({ brandId, feature: 'knowledge.embed', texts: ['a'] }),
    ).rejects.toBeInstanceOf(EmbeddingNotConfiguredError);
  });
});
