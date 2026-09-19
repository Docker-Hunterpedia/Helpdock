import { describe, expect, it } from 'vitest';
import {
  initialSetupState,
  SETUP_STEPS,
  type SetupAction,
  type SetupState,
  setupReducer,
  stepsRemaining,
} from './setup-state.js';

const run = (actions: readonly SetupAction[], start = initialSetupState('en')): SetupState =>
  actions.reduce(setupReducer, start);

const admin: SetupAction = { type: 'adminCreated', name: 'Lina', email: 'lina@example.com' };
const brand: SetupAction = { type: 'brandCreated', name: 'Acme', prefix: 'ACME' };
const smtp: SetupAction = { type: 'smtpDecided', host: 'smtp.example.com' };

describe('setupReducer', () => {
  it('starts on the account step with nothing decided', () => {
    const state = initialSetupState('ar');

    expect(state.step).toBe('account');
    expect(state.locale).toBe('ar');
    expect(state.summary).toEqual({
      adminEmail: '',
      adminName: '',
      brandName: '',
      brandPrefix: '',
      smtpHost: null,
    });
  });

  it('advances one step per decision and remembers what each one produced', () => {
    expect(run([admin]).step).toBe('brand');
    expect(run([admin, brand]).step).toBe('email');
    expect(run([admin, brand, smtp]).step).toBe('done');

    expect(run([admin, brand, smtp]).summary).toEqual({
      adminEmail: 'lina@example.com',
      adminName: 'Lina',
      brandName: 'Acme',
      brandPrefix: 'ACME',
      smtpHost: 'smtp.example.com',
    });
  });

  it('records a skipped email step as having no host', () => {
    expect(run([admin, brand, { type: 'smtpDecided', host: null }]).summary.smtpHost).toBeNull();
  });

  it('goes back a step without losing what the later steps produced', () => {
    const state = run([admin, brand, { type: 'back' }]);

    expect(state.step).toBe('brand');
    expect(state.summary.brandPrefix).toBe('ACME');
  });

  it('has nothing behind the first step', () => {
    const start = initialSetupState('en');

    expect(setupReducer(start, { type: 'back' })).toBe(start);
  });

  it('refuses to go back from done, because the account and the brand exist', () => {
    const done = run([admin, brand, smtp]);

    expect(setupReducer(done, { type: 'back' })).toBe(done);
  });

  it('advances again from a step that was revisited', () => {
    const state = run([admin, brand, { type: 'back' }, brand]);

    expect(state.step).toBe('email');
  });

  it('changes the locale without changing the step', () => {
    const state = run([admin, { type: 'locale', locale: 'ar' }]);

    expect(state.locale).toBe('ar');
    expect(state.step).toBe('brand');
  });
});

describe('stepsRemaining', () => {
  it('counts down to nothing', () => {
    expect(SETUP_STEPS.map(stepsRemaining)).toEqual([3, 2, 1, 0]);
  });
});
