import {
  OPTIONAL_SETUP_CHECKLIST_STEPS,
  SETUP_CHECKLIST_STEPS,
  type SetupChecklist,
  type SetupChecklistStepId,
} from '@helpdock/schemas';

/** What the brand's data says about each step, before it becomes a checklist. */
export type SetupChecklistFacts = Readonly<Record<SetupChecklistStepId, boolean>>;

/**
 * The checklist of a brand from its facts. Pure, so the "ticks itself" rule and
 * the "hides itself once the required steps are done" rule are testable without
 * a database: the optional step counts toward "n of 9" but never holds the
 * checklist open.
 */
export function buildSetupChecklist(
  facts: SetupChecklistFacts,
  dismissed: boolean,
): SetupChecklist {
  const steps = SETUP_CHECKLIST_STEPS.map((id) => ({
    id,
    done: facts[id],
    optional: OPTIONAL_SETUP_CHECKLIST_STEPS.includes(id),
  }));

  return {
    steps,
    doneCount: steps.filter((step) => step.done).length,
    total: steps.length,
    complete: steps.every((step) => step.done || step.optional),
    dismissed,
  };
}
