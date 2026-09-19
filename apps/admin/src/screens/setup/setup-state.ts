import type { Locale } from '@helpdock/i18n';

/**
 * Which step the wizard is on and what the finished steps produced.
 *
 * It is a reducer rather than four `useState` calls because "Back" has to leave
 * the later steps alone while "Continue" has to advance exactly one, and
 * because the done screen summarises all three. Nothing is persisted: a wizard
 * is minutes long, the password in it should not survive a reload, and a
 * half-finished one is finished by starting it again.
 */

export const SETUP_STEPS = ['account', 'brand', 'email', 'done'] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];

export interface SetupSummary {
  readonly adminEmail: string;
  readonly adminName: string;
  readonly brandName: string;
  readonly brandPrefix: string;
  /** The relay's hostname, or null when the step was skipped. */
  readonly smtpHost: string | null;
}

export interface SetupState {
  readonly step: SetupStep;
  readonly locale: Locale;
  readonly summary: SetupSummary;
}

export type SetupAction =
  | { readonly type: 'locale'; readonly locale: Locale }
  | { readonly type: 'back' }
  | { readonly type: 'adminCreated'; readonly name: string; readonly email: string }
  | { readonly type: 'brandCreated'; readonly name: string; readonly prefix: string }
  | { readonly type: 'smtpDecided'; readonly host: string | null };

export const initialSetupState = (locale: Locale): SetupState => ({
  step: 'account',
  locale,
  summary: { adminEmail: '', adminName: '', brandName: '', brandPrefix: '', smtpHost: null },
});

const indexOf = (step: SetupStep): number => SETUP_STEPS.indexOf(step);

const advance = (state: SetupState, to: SetupStep): SetupState => ({ ...state, step: to });

export const setupReducer = (state: SetupState, action: SetupAction): SetupState => {
  switch (action.type) {
    case 'locale':
      return { ...state, locale: action.locale };

    case 'back': {
      const previous = SETUP_STEPS[indexOf(state.step) - 1];

      // The first step has nothing behind it, and the last one is past the
      // point where anything can be changed: the account and the brand exist.
      return previous === undefined || state.step === 'done' ? state : { ...state, step: previous };
    }

    case 'adminCreated':
      return advance(
        {
          ...state,
          summary: { ...state.summary, adminName: action.name, adminEmail: action.email },
        },
        'brand',
      );

    case 'brandCreated':
      return advance(
        {
          ...state,
          summary: { ...state.summary, brandName: action.name, brandPrefix: action.prefix },
        },
        'email',
      );

    case 'smtpDecided':
      return advance({ ...state, summary: { ...state.summary, smtpHost: action.host } }, 'done');
  }
};

/** How many steps are still ahead, for the caption beside the progress list. */
export const stepsRemaining = (step: SetupStep): number => SETUP_STEPS.length - 1 - indexOf(step);
