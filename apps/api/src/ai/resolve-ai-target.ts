import type { Settings } from '@helpdock/config';

/** The part of a brand's `ai_settings` row that picks the model. */
export interface BrandModelChoice {
  readonly providerId: string | null;
  readonly modelId: string | null;
}

/**
 * The provider and model a brand's AI would call: the brand's own pair, else
 * the install's default, and a provider that is still on the install's list.
 * Undefined when there is none, which is "not configured". One rule for the
 * call itself (`DbAiPorts.target`) and for the setup checklist's AI step, so a
 * change here moves both.
 */
export async function resolveAiTarget(
  row: BrandModelChoice | undefined,
  settings: Pick<Settings, 'get'>,
) {
  const providerId = row?.providerId ?? (await settings.get('ai.defaultProvider'));
  const modelId = row?.modelId ?? (await settings.get('ai.defaultModel'));
  const provider = (await settings.get('ai.providers')).find(
    (candidate) => candidate.id === providerId,
  );

  return provider === undefined || modelId === '' ? undefined : { provider, modelId };
}
