import { describe, expect, it } from 'vitest';
import {
  assignableAgentListSchema,
  assignmentAgentUpdateRequestSchema,
  departmentAssignmentUpdateRequestSchema,
  MAX_SKILLS_PER_AGENT,
} from './assignment.js';

const ID = '01937f5e-7e53-7000-8000-000000000001';

describe('departmentAssignmentUpdateRequestSchema', () => {
  it('accepts any one setting, and a null cap as "no cap"', () => {
    expect(departmentAssignmentUpdateRequestSchema.parse({ mode: 'skill_based' })).toEqual({
      mode: 'skill_based',
    });
    expect(departmentAssignmentUpdateRequestSchema.parse({ loadCap: null })).toEqual({
      loadCap: null,
    });
  });

  it('refuses an empty change, which would still write an audit row', () => {
    expect(departmentAssignmentUpdateRequestSchema.safeParse({}).success).toBe(false);
  });

  it('refuses a cap below one and a timer outside a day', () => {
    expect(departmentAssignmentUpdateRequestSchema.safeParse({ loadCap: 0 }).success).toBe(false);
    expect(
      departmentAssignmentUpdateRequestSchema.safeParse({ autoUnassignAfterMinutes: 0 }).success,
    ).toBe(false);
    expect(
      departmentAssignmentUpdateRequestSchema.safeParse({ autoUnassignAfterMinutes: 1_441 })
        .success,
    ).toBe(false);
  });

  it('refuses a mode or on_unassign value it does not know', () => {
    expect(departmentAssignmentUpdateRequestSchema.safeParse({ mode: 'random' }).success).toBe(
      false,
    );
    expect(departmentAssignmentUpdateRequestSchema.safeParse({ onUnassign: 'keep' }).success).toBe(
      false,
    );
  });
});

describe('assignmentAgentUpdateRequestSchema', () => {
  it('accepts rotation, skills, or both', () => {
    expect(assignmentAgentUpdateRequestSchema.parse({ inRotation: false })).toEqual({
      inRotation: false,
    });
    expect(assignmentAgentUpdateRequestSchema.parse({ skillTagIds: [] })).toEqual({
      skillTagIds: [],
    });
  });

  it('refuses nothing to change, and more skills than the ceiling', () => {
    expect(assignmentAgentUpdateRequestSchema.safeParse({}).success).toBe(false);
    expect(
      assignmentAgentUpdateRequestSchema.safeParse({
        skillTagIds: Array.from({ length: MAX_SKILLS_PER_AGENT + 1 }, () => ID),
      }).success,
    ).toBe(false);
  });
});

describe('assignableAgentListSchema', () => {
  it('strips anything beyond what the picker prints', () => {
    const parsed = assignableAgentListSchema.parse({
      departmentId: ID,
      loadCap: 8,
      agents: [
        {
          userId: ID,
          name: 'Lina Haddad',
          presence: 'online',
          openCount: 3,
          email: 'lina@example.com',
          role: 'admin',
        },
      ],
    });

    expect(parsed.agents[0]).toEqual({
      userId: ID,
      name: 'Lina Haddad',
      presence: 'online',
      openCount: 3,
    });
  });
});
