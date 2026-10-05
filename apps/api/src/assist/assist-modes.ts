import type { DbTransaction } from '@helpdock/db';

/**
 * The brand's agent assist mode, as `AI › Assistant` (M7-10) sets it: whether
 * assist runs at all, and whether it keeps running for staff once a budget
 * window is spent (ARCHITECTURE §10).
 */
export interface AssistModes {
  readonly agentAssist: boolean;
  readonly keepAssistAfterHardStop: boolean;
}

export const readAssistModes = async (
  _tx: DbTransaction,
  _brandId: string,
): Promise<AssistModes> => ({ agentAssist: true, keepAssistAfterHardStop: true });
