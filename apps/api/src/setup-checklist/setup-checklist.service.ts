import type { Settings } from '@helpdock/config';
import type { DbTransaction } from '@helpdock/db';
import type { SetupChecklist } from '@helpdock/schemas';
import type { AiRepository } from '../ai/ai.repository.js';
import type { SetupChecklistRepository } from './setup-checklist.repository.js';
import { buildSetupChecklist } from './setup-checklist-steps.js';

export interface SetupChecklistContext {
  readonly tx: DbTransaction;
  readonly brandId: string;
  readonly userId: string;
}

/**
 * M14-13. The checklist is read, never written, except for one person hiding it.
 * Authorization is the route's (`brand:manage`, an Admin's, owner decision D-31);
 * what a step reads is the brand's own rows under the request's transaction.
 */
export class SetupChecklistService {
  readonly #repository: SetupChecklistRepository;
  readonly #ai: AiRepository;
  readonly #settings: Pick<Settings, 'get'>;

  constructor(
    repository: SetupChecklistRepository,
    ai: AiRepository,
    settings: Pick<Settings, 'get'>,
  ) {
    this.#repository = repository;
    this.#ai = ai;
    this.#settings = settings;
  }

  async view({ tx, brandId, userId }: SetupChecklistContext): Promise<SetupChecklist> {
    const [rows, aiProvider, dismissed] = await Promise.all([
      this.#repository.rowFacts(tx, brandId),
      this.#aiProviderIsConnected(tx, brandId),
      this.#repository.isDismissed(tx, brandId, userId),
    ]);

    return buildSetupChecklist({ ...rows, aiProvider }, dismissed);
  }

  async dismiss(context: SetupChecklistContext): Promise<SetupChecklist> {
    await this.#repository.dismiss(context.tx, context.brandId, context.userId);

    return this.view(context);
  }

  /**
   * The provider and model the brand's assistant would call: its own pair or the
   * install's default, and a provider that is still on the install's list. The
   * same resolution `DbAiPorts.target` makes before a call, so the step does not
   * tick for a brand whose first answer would fail as "not configured".
   */
  async #aiProviderIsConnected(tx: DbTransaction, brandId: string): Promise<boolean> {
    const row = await this.#ai.settings(tx, brandId);
    const [providerId, modelId, providers] = await Promise.all([
      row?.providerId ?? this.#settings.get('ai.defaultProvider'),
      row?.modelId ?? this.#settings.get('ai.defaultModel'),
      this.#settings.get('ai.providers'),
    ]);

    return modelId !== '' && providers.some((provider) => provider.id === providerId);
  }
}
