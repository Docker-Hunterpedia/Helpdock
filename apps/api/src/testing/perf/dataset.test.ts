import { describe, expect, it } from 'vitest';
import { DOMAIN_RULES_14, scaleDataset } from './dataset.js';

describe('the DOMAIN-RULES §14 dataset scale', () => {
  it('scales the measured corpus and keeps other brands without knowledge chunks (#154)', () => {
    expect(scaleDataset(DOMAIN_RULES_14.measured, 0.02)).toEqual({
      tickets: 1_000,
      contacts: 400,
      knowledgeChunks: 1_000,
      messagesPerTicket: 4,
    });
    expect(scaleDataset(DOMAIN_RULES_14.others, 0.02).knowledgeChunks).toBe(0);
  });
});
