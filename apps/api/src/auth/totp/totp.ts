import { generateSecret, generateURI, verify } from 'otplib';

/**
 * Time-based one-time passwords (otplib), configured the way an authenticator
 * app expects: SHA-1, six digits, a thirty-second step.
 *
 * The **window of one** is the interesting parameter. otplib takes it as a
 * tolerance in seconds, so one step either side is thirty seconds: it accepts
 * the code that has just rolled over and the one about to, which covers the
 * clock drift between a phone and a server without widening the guessable set
 * beyond three codes in a million.
 */

export const TOTP_PERIOD_SECONDS = 30;
/** One step on each side, expressed as otplib wants it. */
export const TOTP_EPOCH_TOLERANCE_SECONDS = TOTP_PERIOD_SECONDS;
export const TOTP_DIGITS = 6;

/** Base32, which is what an authenticator app scans and what a person types. */
export const newTotpSecret = (): string => generateSecret();

export const verifyTotpCode = async ({
  secret,
  code,
  /** Overridden by the tests, which have to stand at a known point in time. */
  epochSeconds,
}: {
  readonly secret: string;
  readonly code: string;
  readonly epochSeconds?: number;
}): Promise<boolean> => {
  // otplib throws for a token that is not six digits rather than answering
  // false. The Zod schema on the route already refuses those, so reaching this
  // is a bug — but a bug in shape checking must not become a 500 on the sign-in
  // form, and "not six digits" is not a matching code either way.
  try {
    const result = await verify({
      secret,
      token: code,
      digits: TOTP_DIGITS,
      period: TOTP_PERIOD_SECONDS,
      epochTolerance: TOTP_EPOCH_TOLERANCE_SECONDS,
      ...(epochSeconds === undefined ? {} : { epoch: epochSeconds }),
    });

    return result.valid;
  } catch {
    return false;
  }
};

/**
 * The `otpauth://` URI a QR code encodes. The label is the address so that a
 * person with several accounts can tell them apart in the app, and the issuer
 * is the install's own host rather than "Helpdock", for the same reason.
 */
export const totpUri = ({
  secret,
  email,
  issuer,
}: {
  readonly secret: string;
  readonly email: string;
  readonly issuer: string;
}): string => generateURI({ secret, label: email, issuer });
