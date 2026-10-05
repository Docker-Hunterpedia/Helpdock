import {
  type AiAuthType,
  type AiProviderKind,
  type AiProviderUpsert,
  type AiProviderView,
  aiOAuthCredentialsSchema,
  aiProviderIdSchema,
} from '@helpdock/schemas';

/**
 * The provider form's state and the request it makes (M7-10). A stored
 * credential never reaches the browser, so `apiKey` and `oauth` are null while
 * the stored one is kept, and a value once "Replace" was pressed.
 */
export interface ProviderDraft {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly baseUrl: string;
  readonly authType: AiAuthType;
  readonly apiKey: string | null;
  /** The pasted `auth.json`, as text. */
  readonly oauth: string | null;
}

export type ProviderProblem =
  | 'idInvalid'
  | 'labelRequired'
  | 'baseUrlRequired'
  | 'baseUrlInvalid'
  | 'apiKeyRequired'
  | 'oauthInvalid';

export type ProviderField = 'id' | 'label' | 'baseUrl' | 'apiKey' | 'oauth';

export const draftOf = (provider: AiProviderView | null): ProviderDraft =>
  provider === null
    ? { id: '', kind: 'openai', label: '', baseUrl: '', authType: 'apiKey', apiKey: '', oauth: '' }
    : {
        id: provider.id,
        kind: provider.kind,
        label: provider.label,
        baseUrl: provider.baseUrl ?? '',
        authType: provider.authType,
        apiKey: provider.authType === 'apiKey' ? null : '',
        oauth: provider.authType === 'oauth' ? null : '',
      };

const isUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
};

const credentialOf = (
  draft: ProviderDraft,
): { auth: AiProviderUpsert['auth'] } | { problem: ProviderProblem; field: ProviderField } => {
  switch (draft.authType) {
    case 'none':
      return { auth: { type: 'none' } };
    case 'apiKey':
      if (draft.apiKey === null) {
        return { auth: { type: 'apiKey' } };
      }
      return draft.apiKey.trim() === ''
        ? { problem: 'apiKeyRequired', field: 'apiKey' }
        : { auth: { type: 'apiKey', apiKey: draft.apiKey.trim() } };
    case 'oauth': {
      if (draft.oauth === null) {
        return { auth: { type: 'oauth' } };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(draft.oauth);
      } catch {
        return { problem: 'oauthInvalid', field: 'oauth' };
      }
      const credentials = aiOAuthCredentialsSchema.safeParse(parsed);
      return credentials.success
        ? { auth: { type: 'oauth', credentials: credentials.data } }
        : { problem: 'oauthInvalid', field: 'oauth' };
    }
  }
};

/** The request a draft makes, or every field that stops it. */
export const providerRequestOf = (
  draft: ProviderDraft,
  kind: AiProviderKind | undefined,
):
  | { readonly ok: true; readonly id: string; readonly request: AiProviderUpsert }
  | { readonly ok: false; readonly problems: Partial<Record<ProviderField, ProviderProblem>> } => {
  const problems: Partial<Record<ProviderField, ProviderProblem>> = {};
  if (!aiProviderIdSchema.safeParse(draft.id).success) {
    problems.id = 'idInvalid';
  }
  if (draft.label.trim() === '') {
    problems.label = 'labelRequired';
  }
  const baseUrl = draft.baseUrl.trim();
  if (baseUrl === '' && kind?.needsBaseUrl === true) {
    problems.baseUrl = 'baseUrlRequired';
  } else if (baseUrl !== '' && !isUrl(baseUrl)) {
    problems.baseUrl = 'baseUrlInvalid';
  }
  const credential = credentialOf(draft);
  if ('problem' in credential) {
    problems[credential.field] = credential.problem;
  }

  if (Object.keys(problems).length > 0 || 'problem' in credential) {
    return { ok: false, problems };
  }
  return {
    ok: true,
    id: draft.id,
    request: {
      kind: draft.kind,
      label: draft.label.trim(),
      baseUrl: baseUrl === '' ? null : baseUrl,
      auth: credential.auth,
    },
  };
};
