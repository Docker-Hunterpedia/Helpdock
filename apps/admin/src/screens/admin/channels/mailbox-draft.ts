import type {
  ImapTestRequest,
  Mailbox,
  MailboxCreateRequest,
  MailboxMethod,
  MailboxSecurity,
  MailboxUpdateRequest,
  PollInterval,
  RemoteImagePolicy,
} from '@helpdock/schemas';
import { allowlistLines, looksLikeEmail } from './format.js';

/**
 * The mailbox form's state, apart from the screen, so the rules — what a
 * saved mailbox starts as, what counts as a change, what may be sent — are
 * tested on values rather than through clicks.
 *
 * `password` is null while the stored one is kept: a saved password is never
 * in the browser (REQUIREMENTS §5.1), so "unchanged" cannot be a value, only
 * the absence of one. Replace turns it into a string.
 */
export interface MailboxDraft {
  readonly address: string;
  readonly displayName: string;
  readonly departmentId: string;
  readonly method: MailboxMethod;
  readonly host: string;
  readonly port: string;
  readonly security: MailboxSecurity;
  readonly username: string;
  readonly password: string | null;
  readonly folder: string;
  readonly pollIntervalSeconds: PollInterval;
  readonly remoteImages: RemoteImagePolicy;
  readonly authFailureIsSpam: boolean;
  readonly allowlist: string;
}

export type DraftField =
  | 'address'
  | 'displayName'
  | 'departmentId'
  | 'host'
  | 'port'
  | 'username'
  | 'password'
  | 'folder'
  | 'allowlist';

export type DraftErrors = Partial<Record<DraftField, 'required' | 'email' | 'port' | 'password'>>;

export const draftFrom = (
  mailbox: Mailbox | undefined,
  defaultDepartmentId: string,
): MailboxDraft => ({
  address: mailbox?.address ?? '',
  displayName: mailbox?.displayName ?? '',
  departmentId: mailbox?.departmentId ?? defaultDepartmentId,
  method: mailbox?.method ?? 'imap',
  host: mailbox?.imap?.host ?? '',
  port: String(mailbox?.imap?.port ?? 993),
  security: mailbox?.imap?.security ?? 'tls',
  username: mailbox?.imap?.username ?? '',
  // A new mailbox has nothing stored, so its password field is open from the start.
  password: mailbox?.imap?.passwordSet === true ? null : '',
  folder: mailbox?.imap?.folder ?? 'INBOX',
  pollIntervalSeconds: (mailbox?.imap?.pollIntervalSeconds ?? 60) as PollInterval,
  remoteImages: mailbox?.remoteImages ?? 'block',
  authFailureIsSpam: mailbox?.authFailureIsSpam ?? false,
  allowlist: (mailbox?.automatedAllowlist ?? []).join('\n'),
});

export const isDirty = (draft: MailboxDraft, saved: MailboxDraft): boolean =>
  (Object.keys(draft) as (keyof MailboxDraft)[]).some((key) => draft[key] !== saved[key]);

const portOf = (draft: MailboxDraft): number | null => {
  const port = Number(draft.port);
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : null;
};

/** The IMAP half's own problems, which Test IMAP needs too. */
const imapErrors = (
  draft: MailboxDraft,
  { needPassword }: { needPassword: boolean },
): DraftErrors => {
  const errors: DraftErrors = {};
  if (draft.host.trim() === '') {
    errors.host = 'required';
  }
  if (portOf(draft) === null) {
    errors.port = 'port';
  }
  if (draft.username.trim() === '') {
    errors.username = 'required';
  }
  if (draft.folder.trim() === '') {
    errors.folder = 'required';
  }
  if (needPassword && (draft.password === null || draft.password === '')) {
    errors.password = 'password';
  }

  return errors;
};

export type Validated =
  | { readonly ok: true; readonly request: MailboxCreateRequest }
  | { readonly ok: false; readonly errors: DraftErrors };

/**
 * What Save sends, or why it cannot. A new IMAP mailbox needs a password; a
 * saved one keeps its own unless Replace was pressed and something typed.
 * The request is the create shape; the update shape is the same with the
 * password optional, so one builder serves both.
 */
export const validate = (draft: MailboxDraft, { creating }: { creating: boolean }): Validated => {
  const errors: DraftErrors = {};
  if (!looksLikeEmail(draft.address)) {
    errors.address = draft.address.trim() === '' ? 'required' : 'email';
  }
  if (draft.displayName.trim() === '') {
    errors.displayName = 'required';
  }
  if (draft.departmentId === '') {
    errors.departmentId = 'required';
  }
  const allowlist = allowlistLines(draft.allowlist);
  if (allowlist.some((line) => !looksLikeEmail(line))) {
    errors.allowlist = 'email';
  }
  if (draft.method === 'imap') {
    Object.assign(errors, imapErrors(draft, { needPassword: creating || draft.password !== null }));
  }
  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }

  const common = {
    address: draft.address.trim().toLowerCase(),
    displayName: draft.displayName.trim(),
    departmentId: draft.departmentId,
    remoteImages: draft.remoteImages,
    authFailureIsSpam: draft.authFailureIsSpam,
    automatedAllowlist: allowlist,
  };

  return {
    ok: true,
    request:
      draft.method === 'imap'
        ? {
            ...common,
            method: 'imap',
            imap: {
              host: draft.host.trim(),
              port: portOf(draft) ?? 993,
              security: draft.security,
              username: draft.username.trim(),
              folder: draft.folder.trim(),
              pollIntervalSeconds: draft.pollIntervalSeconds,
              // Empty only when Replace was not pressed; the api keeps the stored one.
              password: draft.password ?? '',
            },
          }
        : { ...common, method: 'inbound_parse' },
  };
};

/** The update body: the create body without a password the person did not type. */
export const toUpdate = (
  request: MailboxCreateRequest,
  draft: MailboxDraft,
): MailboxUpdateRequest => {
  if (request.method !== 'imap' || draft.password !== null) {
    return request;
  }
  const { password: _kept, ...imap } = request.imap;

  return { ...request, imap };
};

/** Test IMAP's body, or the problems that stop it being sent. */
export const testRequest = (
  draft: MailboxDraft,
  mailboxId: string | undefined,
):
  | { readonly ok: true; readonly request: ImapTestRequest }
  | { readonly ok: false; readonly errors: DraftErrors } => {
  const errors = imapErrors(draft, {
    needPassword: mailboxId === undefined || draft.password !== null,
  });
  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    request: {
      host: draft.host.trim(),
      port: portOf(draft) ?? 993,
      security: draft.security,
      username: draft.username.trim(),
      folder: draft.folder.trim(),
      ...(draft.password === null || draft.password === '' ? {} : { password: draft.password }),
      ...(mailboxId === undefined ? {} : { mailboxId }),
    },
  };
};
