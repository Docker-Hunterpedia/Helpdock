import { describe, expect, it } from 'vitest';
import {
  MENTION_QUERY_MAX,
  mentionCandidateListSchema,
  mentionCandidateQuerySchema,
} from './mentions.js';

describe('the mention picker schemas (M14-15)', () => {
  it('trims the query and refuses one that is too long', () => {
    expect(mentionCandidateQuerySchema.parse({ q: '  om ' }).q).toBe('om');
    expect(mentionCandidateQuerySchema.parse({}).q).toBeUndefined();
    expect(
      mentionCandidateQuerySchema.safeParse({ q: 'x'.repeat(MENTION_QUERY_MAX + 1) }).success,
    ).toBe(false);
  });

  it('carries a name, a handle and presence, and nothing else through', () => {
    const parsed = mentionCandidateListSchema.parse({
      candidates: [
        {
          userId: '0192c3f0-1a2b-7c3d-8e4f-0000000000a1',
          name: 'Omar Aziz',
          handle: 'omar.aziz',
          presence: 'away',
          email: 'omar.aziz@example.com',
        },
      ],
    });

    expect(parsed.candidates[0]).not.toHaveProperty('email');
  });

  it('refuses an unknown presence', () => {
    expect(
      mentionCandidateListSchema.safeParse({
        candidates: [
          {
            userId: '0192c3f0-1a2b-7c3d-8e4f-0000000000a1',
            name: 'A',
            handle: 'a',
            presence: 'busy',
          },
        ],
      }).success,
    ).toBe(false);
  });
});
