import { describe, expect, it } from 'vitest';
import { DEFAULT_REPORT_DIR, readEvalConfig } from './config.js';

const live = {
  AI_EVAL_MODE: 'live',
  AI_EVAL_PROVIDER_KIND: 'openai',
  AI_EVAL_API_KEY: 'sk-test',
  AI_EVAL_MODEL: 'gpt-4o-mini',
  AI_EVAL_EMBEDDING_BASE_URL: 'https://api.openai.com/v1',
  AI_EVAL_EMBEDDING_API_KEY: 'sk-test',
  AI_EVAL_EMBEDDING_MODEL: 'text-embedding-3-small',
  AI_EVAL_EMBEDDING_DIMS: '1536',
};

describe('readEvalConfig', () => {
  it('defaults to the mocked mode with the brand threshold and the report directory', () => {
    expect(readEvalConfig({})).toEqual({
      mode: 'mock',
      live: null,
      threshold: 0.7,
      concurrency: 4,
      reportDir: DEFAULT_REPORT_DIR,
      databaseUrl: undefined,
      redisUrl: undefined,
    });
  });

  it('treats blank variables as unset', () => {
    expect(
      readEvalConfig({ AI_EVAL_MODE: '', AI_EVAL_THRESHOLD: ' ', AI_EVAL_REPORT_DIR: '' }).mode,
    ).toBe('mock');
  });

  it('reads a live configuration, the judge defaulting to the chat model', () => {
    const config = readEvalConfig({ ...live, AI_EVAL_THRESHOLD: '0.6', AI_EVAL_CONCURRENCY: '2' });
    expect(config.mode).toBe('live');
    expect(config.threshold).toBe(0.6);
    expect(config.concurrency).toBe(2);
    expect(config.live).toEqual({
      providerKind: 'openai',
      apiKey: 'sk-test',
      baseUrl: undefined,
      model: 'gpt-4o-mini',
      judgeModel: undefined,
      embeddings: {
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-test',
        model: 'text-embedding-3-small',
        dims: 1536,
      },
    });
  });

  it('requires the model variables in live mode', () => {
    expect(() => readEvalConfig({ AI_EVAL_MODE: 'live' })).toThrow();
    expect(() => readEvalConfig({ ...live, AI_EVAL_EMBEDDING_DIMS: '4096' })).toThrow();
  });

  it('requires a base URL for an openai-compatible provider', () => {
    expect(() => readEvalConfig({ ...live, AI_EVAL_PROVIDER_KIND: 'openai-compatible' })).toThrow(
      /AI_EVAL_BASE_URL/,
    );
    expect(
      readEvalConfig({
        ...live,
        AI_EVAL_PROVIDER_KIND: 'openai-compatible',
        AI_EVAL_BASE_URL: 'http://localhost:11434/v1',
        AI_EVAL_API_KEY: '',
      }).live,
    ).toMatchObject({ baseUrl: 'http://localhost:11434/v1', apiKey: undefined });
  });

  it('takes the database and Redis together', () => {
    expect(() => readEvalConfig({ AI_EVAL_DATABASE_URL: 'postgres://x/y' })).toThrow(/together/);
    expect(
      readEvalConfig({
        AI_EVAL_DATABASE_URL: 'postgres://x/y',
        AI_EVAL_REDIS_URL: 'redis://localhost:6379',
      }),
    ).toMatchObject({ databaseUrl: 'postgres://x/y', redisUrl: 'redis://localhost:6379' });
  });
});
