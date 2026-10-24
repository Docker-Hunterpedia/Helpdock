import { SETUP_CHECKLIST_STEPS } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import { ROUTES } from '../app/route-paths.js';
import { setupStepRoute } from './setup-checklist-steps.js';

describe('setupStepRoute', () => {
  it('sends every step to a path inside the admin app', () => {
    for (const step of SETUP_CHECKLIST_STEPS) {
      expect(setupStepRoute(step)).toMatch(/^\/[a-z]/);
    }
  });

  it('sends each step to the page where it is done', () => {
    expect(setupStepRoute('channel')).toBe(ROUTES.channels);
    expect(setupStepRoute('teammate')).toBe(ROUTES.staff);
    expect(setupStepRoute('businessHours')).toBe(`${ROUTES.ticketing}/business-hours`);
    expect(setupStepRoute('slaPolicy')).toBe(`${ROUTES.ticketing}/slas`);
    expect(setupStepRoute('assignment')).toBe(`${ROUTES.ticketing}/assignment`);
    expect(setupStepRoute('reply')).toBe(`${ROUTES.automation}/macros`);
    expect(setupStepRoute('article')).toBe(ROUTES.helpCenter);
    expect(setupStepRoute('aiProvider')).toBe(ROUTES.ai);
    expect(setupStepRoute('firstTicket')).toBe(ROUTES.tickets);
  });
});
