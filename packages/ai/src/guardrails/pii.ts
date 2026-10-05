/**
 * PII redaction before any text reaches a model (M7-08, REQUIREMENTS §4.7):
 * email addresses, phone numbers, payment card numbers and IBANs are replaced
 * with numbered placeholders such as `[EMAIL_1]`, and the placeholder map is
 * kept so the original can be put back — for the agent reading the AI log, and
 * in the model's answer before anyone sees it.
 *
 * The detectors are deliberately narrow, because a false positive in a support
 * conversation is an order number the model can no longer read:
 *
 * | Kind | Matches | Then checked by |
 * |---|---|---|
 * | IBAN | two capital letters, two digits, then groups of four capitals or digits, spaced or not | ISO 13616 mod-97 = 1, length 15–34 |
 * | Card | 13–19 digits, single spaces or hyphens between them | Luhn |
 * | Email | `local@domain.tld` | — |
 * | Phone | `+` or `00` then 8–15 digits; or a leading `0` then 9–11 digits; spaces, dots, hyphens and brackets between | digit count |
 *
 * Digits may be Western (0–9), Arabic-Indic (٠–٩) or Extended Arabic-Indic
 * (۰–۹), as Arabic speakers type them. A number that fails its check is left
 * alone: 16 digits that are not a valid card are more likely a tracking code.
 */

export type PiiKind = 'email' | 'phone' | 'card' | 'iban';

export interface Redaction {
  readonly placeholder: string;
  readonly kind: PiiKind;
  readonly original: string;
}

export interface RedactionResult {
  readonly text: string;
  readonly redactions: readonly Redaction[];
}

const DIGIT = '[0-9\\u0660-\\u0669\\u06F0-\\u06F9]';

/** Folds Arabic-Indic and Extended Arabic-Indic digits to ASCII. */
export const toAsciiDigits = (value: string): string =>
  value.replace(/[٠-٩۰-۹]/g, (digit) => {
    const code = digit.charCodeAt(0);
    return String(code >= 0x06f0 ? code - 0x06f0 : code - 0x0660);
  });

const digitsOf = (value: string): string => toAsciiDigits(value).replace(/\D/g, '');

/** The Luhn checksum every payment card number satisfies. */
export const passesLuhn = (digits: string): boolean => {
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let value = Number(digits[index]);
    if (double) {
      value *= 2;
      if (value > 9) {
        value -= 9;
      }
    }
    sum += value;
    double = !double;
  }
  return digits.length > 0 && sum % 10 === 0;
};

const LETTER_OFFSET = 55; // 'A' is 10 in the ISO 13616 alphabet.

/** ISO 13616: move the first four characters to the end, letters to numbers, mod 97 must be 1. */
export const passesIbanChecksum = (value: string): boolean => {
  const iban = value.replace(/\s/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) {
    return false;
  }

  const rearranged = `${iban.slice(4)}${iban.slice(0, 4)}`;
  let remainder = 0;
  for (const character of rearranged) {
    const code = character.charCodeAt(0);
    const numeric = code >= 65 ? String(code - LETTER_OFFSET) : character;
    for (const digit of numeric) {
      remainder = (remainder * 10 + Number(digit)) % 97;
    }
  }
  return remainder === 1;
};

interface Detector {
  readonly kind: PiiKind;
  readonly pattern: RegExp;
  readonly accepts: (match: string) => boolean;
}

/** Order matters: an IBAN contains a card-length run of digits, and a card a phone-length one. */
const DETECTORS: readonly Detector[] = [
  {
    kind: 'iban',
    // Upper case, in groups of four as printed or run together: a lower-case
    // word after the number must not be swallowed into it.
    pattern:
      /(?<![A-Za-z0-9])[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?(?![A-Za-z0-9])/g,
    accepts: passesIbanChecksum,
  },
  {
    kind: 'card',
    pattern: new RegExp(`(?<!${DIGIT})${DIGIT}(?:[ -]?${DIGIT}){12,18}(?!${DIGIT})`, 'g'),
    accepts: (match) => passesLuhn(digitsOf(match)),
  },
  {
    kind: 'email',
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
    accepts: () => true,
  },
  {
    kind: 'phone',
    pattern: new RegExp(
      `(?<![\\w\\u0660-\\u0669\\u06F0-\\u06F9+])(?:\\+|00|\\(?${DIGIT})(?:[\\s().-]{0,2}${DIGIT}){7,16}(?!${DIGIT})`,
      'g',
    ),
    accepts: (match) => {
      const trimmed = toAsciiDigits(match).replace(/^\(/, '');
      const digits = digitsOf(match);
      if (trimmed.startsWith('+')) {
        return digits.length >= 8 && digits.length <= 15;
      }
      if (trimmed.startsWith('00')) {
        return digits.length >= 10 && digits.length <= 17;
      }
      return trimmed.startsWith('0') && digits.length >= 9 && digits.length <= 11;
    },
  },
];

/**
 * One redaction session: the same value gets the same placeholder however
 * often it appears, across every message of one call, so the model can still
 * tell that two mentions are the same address.
 */
export class PiiRedactor {
  readonly #byOriginal = new Map<string, Redaction>();
  readonly #counts = new Map<PiiKind, number>();

  redact(text: string): string {
    let result = text;
    for (const detector of DETECTORS) {
      result = result.replace(detector.pattern, (match) =>
        detector.accepts(match) ? this.#placeholderFor(detector.kind, match) : match,
      );
    }
    return result;
  }

  get redactions(): readonly Redaction[] {
    return [...this.#byOriginal.values()];
  }

  #placeholderFor(kind: PiiKind, original: string): string {
    const known = this.#byOriginal.get(original);
    if (known !== undefined) {
      return known.placeholder;
    }

    const count = (this.#counts.get(kind) ?? 0) + 1;
    this.#counts.set(kind, count);
    const redaction = { placeholder: `[${kind.toUpperCase()}_${count}]`, kind, original };
    this.#byOriginal.set(original, redaction);
    return redaction.placeholder;
  }
}

/** Redacts one text on its own. */
export const redactPii = (text: string): RedactionResult => {
  const redactor = new PiiRedactor();
  const redacted = redactor.redact(text);
  return { text: redacted, redactions: redactor.redactions };
};

/** Puts the originals back where their placeholders are. */
export const restorePii = (text: string, redactions: readonly Redaction[]): string =>
  redactions.reduce(
    (restored, redaction) => restored.replaceAll(redaction.placeholder, redaction.original),
    text,
  );
