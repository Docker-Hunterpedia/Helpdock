import { describe, expect, it } from 'vitest';
import {
  OPTIONAL_SETUP_CHECKLIST_STEPS,
  SETUP_CHECKLIST_STEPS,
  setupChecklistSchema,
} from './setup-checklist.js';

describe('setupChecklistSchema', () => {
  const checklist = {
    steps: [{ id: 'channel', done: true, optional: false }],
    doneCount: 1,
    total: 9,
    complete: false,
    dismissed: false,
  };

  it('takes a list of known steps', () => {
    expect(setupChecklistSchema.parse(checklist)).toEqual(checklist);
  });

  it('refuses a step it does not know', () => {
    const unknown = { ...checklist, steps: [{ id: 'wizard', done: true, optional: false }] };

    expect(setupChecklistSchema.safeParse(unknown).success).toBe(false);
  });

  it('drops a field it does not describe', () => {
    expect(setupChecklistSchema.parse({ ...checklist, brandSecret: 'x' })).toEqual(checklist);
  });

  it('names only steps that exist as optional', () => {
    for (const step of OPTIONAL_SETUP_CHECKLIST_STEPS) {
      expect(SETUP_CHECKLIST_STEPS).toContain(step);
    }
  });
});
