import type { KnowledgeLocale } from '@helpdock/ai';
import { aiSettings, type DbTransaction } from '@helpdock/db';
import {
  type AiAutoReplyChannel,
  parseAiAssistantModes,
  type TicketChannel,
} from '@helpdock/schemas';
import { eq } from 'drizzle-orm';

/**
 * What auto-reply needs of a brand's assistant modes (M7-10's
 * `ai_settings.modes`) for one conversation: null when auto-reply is off on
 * its channel. Whether the answer counts as the first response is the
 * brand's `aiCountsAsFirstResponse`, which the SLA engine reads itself.
 */
export interface AutoReplySettings {
  readonly threshold: number;
  /** The brand's handoff wording in that language, or the built-in one. */
  handoffMessage(locale: KnowledgeLocale): string;
}

export type AutoReplySettingsReader = (
  tx: DbTransaction,
  brandId: string,
  channel: TicketChannel,
) => Promise<AutoReplySettings | null>;

/** What the assistant says when it hands off and the brand wrote nothing of its own. */
export const DEFAULT_HANDOFF_MESSAGES: Readonly<Record<KnowledgeLocale, string>> = {
  en: "I'm not sure about this one, so I'm passing you to the team rather than guess. Someone will reply here shortly.",
  ar: 'لست متأكداً من الإجابة، لذلك سأحوّلك إلى الفريق بدلاً من التخمين. سيرد عليك أحدهم هنا قريباً.',
};

/** The ticket channels auto-reply answers on, by the name the modes give them. */
const MODE_CHANNEL: Partial<Record<TicketChannel, AiAutoReplyChannel>> = {
  chat: 'widget',
  email: 'email',
  telegram: 'telegram',
};

export const readAutoReplySettings: AutoReplySettingsReader = async (tx, brandId, channel) => {
  const modeChannel = MODE_CHANNEL[channel];
  if (modeChannel === undefined) {
    return null;
  }
  const [row] = await tx
    .select({ modes: aiSettings.modes })
    .from(aiSettings)
    .where(eq(aiSettings.brandId, brandId))
    .limit(1);
  const modes = parseAiAssistantModes(row?.modes);
  const { enabled, threshold } = modes.autoReply[modeChannel];
  if (!enabled) {
    return null;
  }
  return {
    threshold,
    handoffMessage: (locale) =>
      modes.handoffMessage[locale].trim() === ''
        ? DEFAULT_HANDOFF_MESSAGES[locale]
        : modes.handoffMessage[locale].trim(),
  };
};
