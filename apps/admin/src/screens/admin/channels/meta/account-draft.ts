import {
  META_EXTERNAL_ID_PATTERN,
  META_TOKEN_MAX_LENGTH,
  META_TOKEN_MIN_LENGTH,
  type MetaAccount,
  type MetaAccountUpdateRequest,
} from '@helpdock/schemas';

/**
 * The account form of `Admin/Channels-Meta-Account` (M10-07) as plain data:
 * what the person has changed, whether it differs from what is saved, and the
 * request it becomes. `token` is null while the saved token is kept; Replace
 * makes it a string, which the save sends.
 */
export interface AccountDraft {
  readonly departmentId: string;
  readonly humanAgentEnabled: boolean;
  readonly token: string | null;
}

export type AccountDraftField = 'token';
export type AccountDraftErrors = Partial<Record<AccountDraftField, 'malformed'>>;

export const draftFromAccount = (account: MetaAccount): AccountDraft => ({
  departmentId: account.departmentId,
  humanAgentEnabled: account.humanAgentEnabled,
  token: null,
});

export const isDraftDirty = (draft: AccountDraft, saved: AccountDraft): boolean =>
  draft.departmentId !== saved.departmentId ||
  draft.humanAgentEnabled !== saved.humanAgentEnabled ||
  draft.token !== null;

/** What the dashboard hands out, checked before a round trip to Meta. */
export const looksLikeToken = (value: string): boolean => {
  const token = value.trim();
  return (
    token.length >= META_TOKEN_MIN_LENGTH &&
    token.length <= META_TOKEN_MAX_LENGTH &&
    /^\S+$/.test(token)
  );
};

/** A phone number id, a Page id or an Instagram account id: digits, as Meta issues them. */
export const looksLikeId = (value: string): boolean => META_EXTERNAL_ID_PATTERN.test(value.trim());

export const validateDraft = (
  draft: AccountDraft,
  account: Pick<MetaAccount, 'platform' | 'displayName'>,
):
  | { readonly ok: true; readonly request: MetaAccountUpdateRequest }
  | { readonly ok: false; readonly errors: AccountDraftErrors } => {
  if (draft.token !== null && !looksLikeToken(draft.token)) {
    return { ok: false, errors: { token: 'malformed' } };
  }

  return {
    ok: true,
    request: {
      displayName: account.displayName,
      departmentId: draft.departmentId,
      // Human Agent is Messenger's and Instagram's; a WhatsApp number never sends it on.
      humanAgentEnabled: account.platform !== 'whatsapp' && draft.humanAgentEnabled,
      ...(draft.token === null ? {} : { accessToken: draft.token.trim() }),
    },
  };
};
