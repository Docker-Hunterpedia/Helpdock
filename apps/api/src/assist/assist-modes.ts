import type { DbTransaction } from '@helpdock/db';
import { parseAiAssistantModes } from '@helpdock/schemas';
import { AiRepository } from '../ai/ai.repository.js';

/**
 * The brand's agent assist mode, as `AI › Assistant` (M7-10) sets it in
 * `ai_settings.modes`: whether assist runs at all, and whether it keeps
 * running for staff once a budget window is spent (ARCHITECTURE §10). A brand
 * with no row has every mode off.
 */
export interface AssistModes {
  readonly agentAssist: boolean;
  readonly keepAssistAfterHardStop: boolean;
}

const repository = new AiRepository();

export const readAssistModes = async (tx: DbTransaction, brandId: string): Promise<AssistModes> => {
  const { agentAssist, keepAssistAfterHardStop } = parseAiAssistantModes(
    (await repository.settings(tx, brandId))?.modes,
  );
  return { agentAssist, keepAssistAfterHardStop };
};
