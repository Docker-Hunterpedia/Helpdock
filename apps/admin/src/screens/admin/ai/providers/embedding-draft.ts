import {
  EMBEDDING_MAX_DIMS,
  type EmbeddingSettingsUpdate,
  type EmbeddingSettingsView,
} from '@helpdock/schemas';

/** The embeddings card's state, as typed. `apiKey` is null while the stored key is kept. */
export interface EmbeddingDraft {
  readonly provider: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly dims: string;
  readonly price: string;
  readonly apiKey: string | null;
}

export type EmbeddingProblem =
  | 'providerRequired'
  | 'baseUrlInvalid'
  | 'modelRequired'
  | 'dimsInvalid'
  | 'dimsTooMany'
  | 'priceInvalid';

export type EmbeddingField = 'provider' | 'baseUrl' | 'model' | 'dims' | 'price';

export const embeddingDraftOf = (settings: EmbeddingSettingsView): EmbeddingDraft => ({
  provider: settings.provider,
  baseUrl: settings.baseUrl,
  model: settings.model,
  dims: settings.dims === 0 ? '' : String(settings.dims),
  price: String(settings.pricePerMillionTokens),
  apiKey: settings.hasApiKey ? null : '',
});

/**
 * The request a draft makes, or every field that stops it. Above 2000
 * dimensions is refused here with the reason (ADR 0005), before the api is
 * asked, because that is the mistake an operator choosing a large model makes.
 */
export const embeddingRequestOf = (
  draft: EmbeddingDraft,
):
  | { readonly ok: true; readonly request: Omit<EmbeddingSettingsUpdate, 'confirmReembed'> }
  | {
      readonly ok: false;
      readonly problems: Partial<Record<EmbeddingField, EmbeddingProblem>>;
    } => {
  const problems: Partial<Record<EmbeddingField, EmbeddingProblem>> = {};
  const dims = Number(draft.dims);
  const price = Number(draft.price);

  if (draft.provider.trim() === '') {
    problems.provider = 'providerRequired';
  }
  if (!/^https?:\/\/\S+$/.test(draft.baseUrl.trim())) {
    problems.baseUrl = 'baseUrlInvalid';
  }
  if (draft.model.trim() === '') {
    problems.model = 'modelRequired';
  }
  if (!Number.isInteger(dims) || dims < 1) {
    problems.dims = 'dimsInvalid';
  } else if (dims > EMBEDDING_MAX_DIMS) {
    problems.dims = 'dimsTooMany';
  }
  if (draft.price.trim() === '' || !Number.isFinite(price) || price < 0 || price > 1_000) {
    problems.price = 'priceInvalid';
  }

  if (Object.keys(problems).length > 0) {
    return { ok: false, problems };
  }
  return {
    ok: true,
    request: {
      provider: draft.provider.trim(),
      baseUrl: draft.baseUrl.trim(),
      model: draft.model.trim(),
      dims,
      pricePerMillionTokens: price,
      ...(draft.apiKey === null ? {} : { apiKey: draft.apiKey }),
    },
  };
};

/** True when saving would move every chunk to another model (ADR 0005). */
export const changesSpace = (
  settings: EmbeddingSettingsView,
  request: Pick<EmbeddingSettingsUpdate, 'model' | 'dims'>,
): boolean =>
  settings.model !== '' && (settings.model !== request.model || settings.dims !== request.dims);
