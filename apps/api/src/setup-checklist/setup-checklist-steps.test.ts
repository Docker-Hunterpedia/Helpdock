import { SETUP_CHECKLIST_STEPS, type SetupChecklistStepId } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import { buildSetupChecklist, type SetupChecklistFacts } from './setup-checklist-steps.js';

const facts = (done: readonly SetupChecklistStepId[]): SetupChecklistFacts =>
  Object.fromEntries(SETUP_CHECKLIST_STEPS.map((id) => [id, done.includes(id)])) as Record<
    SetupChecklistStepId,
    boolean
  >;

describe('buildSetupChecklist', () => {
  it('lists the nine steps in the panel’s order and counts the ones done', () => {
    const checklist = buildSetupChecklist(facts(['channel', 'businessHours']), false);

    expect(checklist.steps.map((step) => step.id)).toEqual([...SETUP_CHECKLIST_STEPS]);
    expect(checklist.steps.filter((step) => step.done).map((step) => step.id)).toEqual([
      'channel',
      'businessHours',
    ]);
    expect(checklist.doneCount).toBe(2);
    expect(checklist.total).toBe(9);
    expect(checklist.complete).toBe(false);
  });

  it('marks only the AI provider as optional', () => {
    const optional = buildSetupChecklist(facts([]), false)
      .steps.filter((step) => step.optional)
      .map((step) => step.id);

    expect(optional).toEqual(['aiProvider']);
  });

  it('is complete once every required step is done, with the optional one undone', () => {
    const required = SETUP_CHECKLIST_STEPS.filter((id) => id !== 'aiProvider');
    const checklist = buildSetupChecklist(facts(required), false);

    expect(checklist.complete).toBe(true);
    expect(checklist.doneCount).toBe(8);
  });

  it('is not complete while one required step is missing, however many others are done', () => {
    const missing = SETUP_CHECKLIST_STEPS.filter((id) => id !== 'firstTicket');

    expect(buildSetupChecklist(facts(missing), false).complete).toBe(false);
  });

  it('carries whether the reader hid it', () => {
    expect(buildSetupChecklist(facts([]), true).dismissed).toBe(true);
  });
});
