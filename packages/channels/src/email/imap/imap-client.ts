import type { ConnectionOptions } from 'node:tls';
import { ImapFlow, type ImapFlowOptions } from 'imapflow';

/**
 * The IMAP half of M2-02 and the "Test IMAP" button of M2-08, over imapflow
 * (ARCHITECTURE §1). It knows nothing about brands, tickets or the database:
 * it signs in, reads a folder from a cursor, and says what went wrong in words
 * the admin screen can show.
 */

export interface ImapSettings {
  readonly host: string;
  readonly port: number;
  /** `tls` is implicit TLS; `starttls` refuses to continue without the upgrade. */
  readonly security: 'tls' | 'starttls';
  readonly username: string;
  readonly password: string;
  readonly folder: string;
}

/**
 * What a connection may be told beyond the mailbox's own settings. Production
 * passes nothing; the integration suite passes `rejectUnauthorized: false` for
 * its self-signed test server, which is why it is a parameter and not a mailbox
 * setting an Admin could turn off.
 */
export interface ImapConnectOptions {
  readonly tls?: ConnectionOptions;
  /** The whole attempt, sign-in included. The artboard's "times out after 15 s". */
  readonly timeoutMs?: number;
  /**
   * Turns the typed host into the one address to connect to, or throws. The
   * api passes `@helpdock/net`'s `resolvePublicHost` so a mailbox cannot point
   * the server at its own network (DOMAIN-RULES §13); the name is still used
   * for TLS, so the certificate is checked against what the Admin typed.
   */
  readonly resolveHost?: (host: string) => Promise<string>;
}

export const IMAP_TEST_TIMEOUT_MS = 15_000;

export type ImapFailureKind = 'auth' | 'connect' | 'timeout' | 'folder';

/** A failure in the admin's vocabulary, with the server's own answer when it gave one. */
export class ImapFailure extends Error {
  readonly kind: ImapFailureKind;
  readonly serverResponse: string | null;

  constructor(kind: ImapFailureKind, serverResponse: string | null, cause?: unknown) {
    super(`IMAP ${kind} failure${serverResponse === null ? '' : `: ${serverResponse}`}`, { cause });
    this.name = 'ImapFailure';
    this.kind = kind;
    this.serverResponse = serverResponse;
  }
}

interface ImapFlowErrorShape {
  readonly code?: string;
  readonly responseStatus?: string;
  readonly authenticationFailed?: boolean;
  readonly responseText?: string;
  readonly serverResponseCode?: string;
  readonly response?: string;
}

/** Turns whatever imapflow or the socket threw into an {@link ImapFailure}. */
export const classifyImapError = (error: unknown): ImapFailure => {
  if (error instanceof ImapFailure) {
    return error;
  }

  const shape = (typeof error === 'object' && error !== null ? error : {}) as ImapFlowErrorShape;
  const response =
    shape.response?.trim() ||
    shape.responseText?.trim() ||
    (error instanceof Error ? error.message : null) ||
    null;

  if (shape.authenticationFailed === true || shape.serverResponseCode === 'AUTHENTICATIONFAILED') {
    return new ImapFailure('auth', response, error);
  }
  if (
    shape.code === 'ETIMEOUT' ||
    shape.code === 'ETIMEDOUT' ||
    shape.code === 'ConnectionTimeout'
  ) {
    return new ImapFailure('timeout', null, error);
  }
  if (
    shape.serverResponseCode === 'NONEXISTENT' ||
    /mailbox.*(?:not|doesn)|no such mailbox/i.test(response ?? '')
  ) {
    return new ImapFailure('folder', response, error);
  }

  return new ImapFailure('connect', response, error);
};

const addressFor = async (settings: ImapSettings, options: ImapConnectOptions): Promise<string> => {
  if (options.resolveHost === undefined) {
    return settings.host;
  }
  try {
    return await options.resolveHost(settings.host);
  } catch (error) {
    throw new ImapFailure('connect', error instanceof Error ? error.message : null, error);
  }
};

const clientFor = async (
  settings: ImapSettings,
  options: ImapConnectOptions,
): Promise<ImapFlow> => {
  const timeout = options.timeoutMs ?? IMAP_TEST_TIMEOUT_MS;
  const address = await addressFor(settings, options);
  const config: ImapFlowOptions = {
    host: address,
    port: settings.port,
    ...(address === settings.host ? {} : { servername: settings.host }),
    secure: settings.security === 'tls',
    // `starttls` must not quietly carry on in plain text when the server does
    // not offer the upgrade: that would send the password in the clear.
    doSTARTTLS: settings.security === 'starttls' ? true : undefined,
    auth: { user: settings.username, pass: settings.password },
    // imapflow's logger would write the protocol exchange, and a LOGIN line
    // contains the password. Nothing here is worth that.
    logger: false,
    disableAutoIdle: true,
    connectionTimeout: timeout,
    greetingTimeout: timeout,
    socketTimeout: timeout * 2,
    ...(options.tls === undefined ? {} : { tls: options.tls }),
  };

  return new ImapFlow(config);
};

const withDeadline = async <T>(work: Promise<T>, timeoutMs: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new ImapFailure('timeout', null));
    }, timeoutMs);
  });

  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Opening or counting a folder after a successful sign-in: a `NO` here is the
 * folder's fault, whatever words the server chose for it.
 */
const onFolder = async <T>(work: () => Promise<T>): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    const shape = (typeof error === 'object' && error !== null ? error : {}) as ImapFlowErrorShape;
    if (shape.responseStatus === 'NO') {
      throw new ImapFailure(
        'folder',
        shape.response?.trim() || shape.responseText?.trim() || null,
        error,
      );
    }
    throw error;
  }
};

const closeQuietly = async (client: ImapFlow): Promise<void> => {
  try {
    await client.logout();
  } catch {
    client.close();
  }
};

export interface ImapTestOutcome {
  readonly messages: number;
  readonly unseen: number;
}

/**
 * Signs in and counts the folder. Imports nothing and marks nothing read:
 * "Nothing was imported."
 */
export const testImapConnection = async (
  settings: ImapSettings,
  options: ImapConnectOptions = {},
): Promise<ImapTestOutcome> => {
  const client = await clientFor(settings, options);
  // A failed connect emits `error` as well as rejecting; without a listener
  // that second copy would crash the process.
  client.on('error', () => undefined);

  try {
    return await withDeadline(
      (async () => {
        await client.connect();
        // EXAMINE rather than STATUS: some servers answer STATUS for a folder
        // that does not exist, and read-only means nothing is marked read.
        const lock = await onFolder(() =>
          client.getMailboxLock(settings.folder, { readOnly: true }),
        );
        try {
          const unseen = await client.search({ seen: false });
          const mailbox = client.mailbox;
          return {
            messages: mailbox === false ? 0 : mailbox.exists,
            unseen: unseen === false || unseen === undefined ? 0 : unseen.length,
          };
        } finally {
          lock.release();
        }
      })(),
      options.timeoutMs ?? IMAP_TEST_TIMEOUT_MS,
    );
  } catch (error) {
    throw classifyImapError(error);
  } finally {
    await closeQuietly(client);
  }
};

/** Where the poller got to in a folder. */
export interface ImapCursor {
  /** The folder's `UIDVALIDITY` when the cursor was taken, as a decimal string. */
  readonly uidValidity: string | null;
  readonly lastUid: number | null;
}

export interface ImapPollOptions extends ImapConnectOptions {
  /** How many messages one poll imports at most. The next poll takes the rest. */
  readonly maxMessages?: number;
  /** A message larger than this is skipped and reported, never downloaded. */
  readonly maxMessageBytes?: number;
  /** Called for a message that was skipped for its size. */
  readonly onSkipped?: (uid: number, size: number) => void;
}

export interface ImapPollResult extends ImapCursor {
  readonly imported: number;
  /**
   * What `onMessage` threw, when it did. The poll stopped at that message and
   * the cursor is the one before it; the caller saves the cursor and reports.
   */
  readonly handlerError: unknown;
}

export const IMAP_POLL_BATCH = 50;
export const IMAP_MAX_MESSAGE_BYTES = 40 * 1024 * 1024;

/**
 * Hands each new message's raw bytes to `onMessage`, oldest first, and returns
 * the cursor after the last one it finished.
 *
 * The cursor advances **only past a message `onMessage` finished**. If it
 * throws, the poll stops there and returns the cursor before it with the
 * error in `handlerError`, so the next
 * poll tries the same message again; a message that was already stored is
 * recognised by its `Message-ID` then. Each finished message is also flagged
 * `\Seen`, so a person reading the same mailbox in a mail client can tell what
 * the desk has taken.
 *
 * A first poll, or one after the server renumbered the folder (a different
 * `UIDVALIDITY`), starts from the unseen messages rather than from the whole
 * folder's history.
 */
export const pollImapFolder = async (
  settings: ImapSettings,
  cursor: ImapCursor,
  onMessage: (raw: Buffer, uid: number) => Promise<void>,
  options: ImapPollOptions = {},
): Promise<ImapPollResult> => {
  const client = await clientFor(settings, options);
  client.on('error', () => undefined);
  const maxMessages = options.maxMessages ?? IMAP_POLL_BATCH;
  const maxBytes = options.maxMessageBytes ?? IMAP_MAX_MESSAGE_BYTES;

  try {
    await client.connect();
  } catch (error) {
    await closeQuietly(client);
    throw classifyImapError(error);
  }

  let lock: Awaited<ReturnType<ImapFlow['getMailboxLock']>> | undefined;
  try {
    lock = await onFolder(() => client.getMailboxLock(settings.folder));
    const mailbox = client.mailbox;
    /* c8 ignore next 3 -- a lock is only granted on an open mailbox. */
    if (mailbox === false) {
      throw new ImapFailure('folder', null);
    }

    const uidValidity = mailbox.uidValidity.toString();
    const continuing = cursor.uidValidity === uidValidity && cursor.lastUid !== null;
    const found = continuing
      ? await client.search({ uid: `${String((cursor.lastUid ?? 0) + 1)}:*` }, { uid: true })
      : await client.search({ seen: false }, { uid: true });

    // `n:*` always matches the last message, even when its uid is below n.
    const candidates = (found === false || found === undefined ? [] : found)
      .filter((uid) => !continuing || uid > (cursor.lastUid ?? 0))
      .sort((a, b) => a - b);
    const uids = candidates.slice(0, maxMessages);
    const truncated = candidates.length > uids.length;

    let lastUid = continuing ? cursor.lastUid : null;
    let imported = 0;
    let handlerError: unknown = null;

    for (const uid of uids) {
      const meta = await client.fetchOne(String(uid), { uid: true, size: true }, { uid: true });
      const size = meta === false || meta === undefined ? 0 : (meta.size ?? 0);
      if (size > maxBytes) {
        options.onSkipped?.(uid, size);
      } else {
        const message = await client.fetchOne(
          String(uid),
          { uid: true, source: true },
          { uid: true },
        );
        const source = message === false || message === undefined ? undefined : message.source;
        if (source !== undefined) {
          try {
            await onMessage(source, uid);
          } catch (error) {
            handlerError = error;
            break;
          }
          imported += 1;
        }
      }

      await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
      lastUid = Math.max(lastUid ?? 0, uid);
    }

    if (continuing || handlerError !== null) {
      return { uidValidity, lastUid, imported, handlerError };
    }

    // A first poll read the unseen messages. When it read all of them, the
    // cursor jumps to the end of the folder, so the seen history below is never
    // imported; when the batch cap cut it short, it stays in "unseen" mode and
    // the next poll reads the rest the same way.
    return truncated
      ? { uidValidity: null, lastUid: null, imported, handlerError }
      : {
          uidValidity,
          lastUid: Math.max(lastUid ?? 0, mailbox.uidNext - 1),
          imported,
          handlerError,
        };
  } catch (error) {
    throw classifyImapError(error);
  } finally {
    lock?.release();
    await closeQuietly(client);
  }
};
