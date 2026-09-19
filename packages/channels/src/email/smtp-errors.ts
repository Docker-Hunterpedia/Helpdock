import type { SmtpErrorCode } from '@helpdock/schemas';

/**
 * Turns whatever Nodemailer threw into one of the codes the wizard's screen has
 * a sentence for.
 *
 * It is a separate module because it is the part worth testing exhaustively and
 * the part that must never widen: the code is all that leaves the server. A
 * relay's own message is not returned, because it quotes the address that was
 * refused and sometimes the account it was refused for, and the wizard's error
 * card is shown before anyone has signed in.
 */

/** Nodemailer sets `code` on everything it raises (`ERROR_CODES` in its source). */
interface NodemailerError {
  readonly code?: unknown;
  readonly responseCode?: unknown;
  readonly errno?: unknown;
}

const BY_NODEMAILER_CODE: Readonly<Record<string, SmtpErrorCode>> = {
  EAUTH: 'auth-failed',
  ENOAUTH: 'auth-failed',
  EOAUTH2: 'auth-failed',
  ETLS: 'tls-error',
  EREQUIRETLS: 'tls-error',
  ETIMEDOUT: 'timeout',
  ECONNECTION: 'connection-refused',
  ESOCKET: 'connection-refused',
  EDNS: 'connection-refused',
  EPROXY: 'connection-refused',
  // The connection worked and the conversation did not: a rejected sender, a
  // rejected recipient, a message the relay would not take.
  EENVELOPE: 'rejected',
  EMESSAGE: 'rejected',
  EPROTOCOL: 'rejected',
};

/** What Node's own socket layer raises when Nodemailer has not wrapped it. */
const BY_SYSTEM_CODE: Readonly<Record<string, SmtpErrorCode>> = {
  ECONNREFUSED: 'connection-refused',
  ECONNRESET: 'connection-refused',
  EHOSTUNREACH: 'connection-refused',
  ENETUNREACH: 'connection-refused',
  ENOTFOUND: 'connection-refused',
  EAI_AGAIN: 'connection-refused',
  ETIMEDOUT: 'timeout',
};

const codeOf = (error: unknown): string | undefined => {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }

  const { code, errno } = error as NodemailerError;
  if (typeof code === 'string') {
    return code;
  }

  return typeof errno === 'string' ? errno : undefined;
};

/** Raised by {@link classifySmtpError}'s caller when its own deadline passes first. */
export class SmtpTimeoutError extends Error {
  constructor() {
    super('The SMTP server did not answer in time');
    this.name = 'SmtpTimeoutError';
  }
}

export const classifySmtpError = (error: unknown): SmtpErrorCode => {
  if (error instanceof SmtpTimeoutError) {
    return 'timeout';
  }

  const code = codeOf(error);
  if (code === undefined) {
    return 'unknown';
  }

  return BY_NODEMAILER_CODE[code] ?? BY_SYSTEM_CODE[code] ?? 'unknown';
};
