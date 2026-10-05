import { describe, expect, it } from 'vitest';
import type { Db } from './client.js';
import { MAX_EMBEDDING_DIMS, setEmbeddingDims, toVectorLiteral } from './embedding-space.js';

const unreachable = {
  execute: () => Promise.reject(new Error('must not reach the database')),
} as unknown as Db;

describe('setEmbeddingDims', () => {
  it.each([0, -1, 1.5, MAX_EMBEDDING_DIMS + 1, 3_072])(
    'refuses %s before reaching the database (ADR 0005)',
    async (dims) => {
      await expect(setEmbeddingDims(unreachable, dims)).rejects.toBeInstanceOf(RangeError);
    },
  );
});

describe('toVectorLiteral', () => {
  it('writes the text form pgvector reads', () => {
    expect(toVectorLiteral([0.5, -1, 0])).toBe('[0.5,-1,0]');
  });

  it('refuses a value that is not a finite number', () => {
    expect(() => toVectorLiteral([1, Number.NaN])).toThrow(RangeError);
    expect(() => toVectorLiteral([Number.POSITIVE_INFINITY])).toThrow(RangeError);
  });
});
