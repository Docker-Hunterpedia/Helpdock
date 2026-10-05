import { describe, expect, it } from 'vitest';
import { validateCitations } from './citations.js';

const retrieved = [{ chunkId: 'chunk-a' }, { chunkId: 'chunk-b' }];

describe('validateCitations', () => {
  it('keeps citations of chunks the model was given', () => {
    const check = validateCitations(
      'Refunds take five days [1]. Exchanges are free [2].',
      retrieved,
    );

    expect(check).toEqual({
      text: 'Refunds take five days [1]. Exchanges are free [2].',
      citations: [
        { marker: 1, chunkId: 'chunk-a' },
        { marker: 2, chunkId: 'chunk-b' },
      ],
      dropped: [],
      handoff: false,
      uncited: false,
    });
  });

  it('drops a fabricated citation and asks for the handoff', () => {
    const check = validateCitations(
      'Refunds take five days [1]. Gift cards never expire [7].',
      retrieved,
    );

    expect(check.text).toBe('Refunds take five days [1]. Gift cards never expire.');
    expect(check.citations).toEqual([{ marker: 1, chunkId: 'chunk-a' }]);
    expect(check.dropped).toEqual([7]);
    expect(check.handoff).toBe(true);
  });

  it('drops a zero marker and keeps the valid half of a group', () => {
    const check = validateCitations('Five days [0, 2] and [2].', retrieved);

    expect(check.text).toBe('Five days [2] and [2].');
    expect(check.citations).toEqual([{ marker: 2, chunkId: 'chunk-b' }]);
    expect(check.dropped).toEqual([0]);
    expect(check.handoff).toBe(true);
  });

  it('reports an answer that cites nothing', () => {
    const check = validateCitations('I am not sure.', retrieved);

    expect(check.uncited).toBe(true);
    expect(check.handoff).toBe(false);
  });
});
