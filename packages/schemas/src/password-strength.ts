/**
 * A small, dependency-free strength estimate for a password somebody is
 * choosing. It exists so the wizard's meter and the api's refusal agree: the
 * screen draws what this function returns and the server refuses what it calls
 * `weak`, so a password can never pass the meter and then be rejected.
 *
 * It is deliberately not zxcvbn. That library is several hundred kilobytes of
 * dictionaries, which would be the largest thing in the admin bundle, and the
 * rule Helpdock needs is the one NIST SP 800-63B states: length carries the
 * strength, and the thing worth blocking outright is a password that is
 * obviously guessable. So this counts length and variety, and subtracts for the
 * shapes that make a long password worthless — one unit repeated, a keyboard
 * run, or something from the short list below.
 *
 * M0-06 reuses it for the invite-acceptance form.
 */

export const PASSWORD_STRENGTHS = ['weak', 'fair', 'good', 'strong'] as const;
export type PasswordStrength = (typeof PASSWORD_STRENGTHS)[number];

/**
 * What people type when they are told "at least twelve characters" and do not
 * mean it. Compared after lower-casing and dropping everything that is not a
 * letter or a digit, so `Password-123!` is caught too.
 */
const OBVIOUS = new Set([
  'password',
  'password1',
  'password12',
  'password123',
  'passw0rd123',
  'letmein',
  'letmein123',
  'welcome123',
  'admin',
  'administrator',
  'admin123',
  'changeme',
  'changeme123',
  'helpdock',
  'helpdock123',
  'qwerty',
  'qwerty123',
  'qwertyuiop',
  'iloveyou',
  'secret',
  'secret123',
]);

/** Runs of four or more that make a long password short in practice. */
const KEYBOARD_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm', '1234567890'];

const RUN_LENGTH = 4;

/** Below this a password is weak whatever else it does; the same floor as `passwordSchema`. */
const MIN_LENGTH = 12;
const LONG = 16;
const VERY_LONG = 20;

const normalise = (password: string): string => password.toLowerCase().replaceAll(/[^a-z0-9]/g, '');

const hasKeyboardRun = (password: string): boolean => {
  const lower = password.toLowerCase();

  for (const row of KEYBOARD_ROWS) {
    const reversed = [...row].reverse().join('');
    for (let start = 0; start + RUN_LENGTH <= row.length; start += 1) {
      if (
        lower.includes(row.slice(start, start + RUN_LENGTH)) ||
        lower.includes(reversed.slice(start, start + RUN_LENGTH))
      ) {
        return true;
      }
    }
  }

  return false;
};

/** `aaaaaaaaaaaa`, `abababababab`: a short string typed until it is long enough. */
const isRepeatedUnit = (password: string): boolean => {
  const lower = password.toLowerCase();

  for (let size = 1; size <= Math.floor(lower.length / 2); size += 1) {
    if (lower.length % size !== 0) {
      continue;
    }
    if (lower === lower.slice(0, size).repeat(lower.length / size)) {
      return true;
    }
  }

  return false;
};

const varietyOf = (password: string): number =>
  [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((pattern) => pattern.test(password)).length;

export interface PasswordStrengthReading {
  readonly strength: PasswordStrength;
  /** 0–3, so a meter draws the same four steps as {@link PASSWORD_STRENGTHS}. */
  readonly score: number;
}

/**
 * The reading the meter draws and the api enforces. `weak` is the only value
 * that is refused; the other three are a hint and not a gate, because a rule
 * that demands a symbol is how people end up with `Password1!`.
 */
export const estimatePasswordStrength = (password: string): PasswordStrengthReading => {
  const guessable =
    OBVIOUS.has(normalise(password)) ||
    (password.length > 0 && isRepeatedUnit(password)) ||
    hasKeyboardRun(password);

  if (guessable || password.length < MIN_LENGTH) {
    return { strength: 'weak', score: 0 };
  }

  const variety = varietyOf(password);
  const long = password.length >= LONG;

  if (password.length >= VERY_LONG || (long && variety >= 3) || variety === 4) {
    return { strength: 'strong', score: 3 };
  }
  if (long || variety >= 3) {
    return { strength: 'good', score: 2 };
  }

  return { strength: 'fair', score: 1 };
};

/** What the api refuses: anything the meter would draw at its lowest step. */
export const isPasswordAcceptable = (password: string): boolean =>
  estimatePasswordStrength(password).strength !== 'weak';
