import type { KnowledgeLocale } from '@helpdock/ai';
import type { DbTransaction } from '@helpdock/db';
import type { TicketChannel } from '@helpdock/schemas';

/**
 * What auto-reply needs of a brand's assistant modes (M7-10's settings) for
 * one conversation: null when auto-reply is off on its channel.
 */
export interface AutoReplySettings {
  readonly threshold: number;
  /** The brand's handoff wording in that language, or the built-in one. */
  handoffMessage(locale: KnowledgeLocale): string;
}

/** What the assistant says when it hands off and the brand wrote nothing of its own. */
export const DEFAULT_HANDOFF_MESSAGES: Readonly<Record<KnowledgeLocale, string>> = {
  en: "I'm not sure about this one, so I'm passing you to the team rather than guess. Someone will reply here shortly.",
  ar: 'لست متأكدًا من الإجابة عن هذا السؤال، لذلك حوّلت المحادثة إلى فريقنا بدلًا من التخمين. سيردّ عليك أحدهم هنا قريبًا.',
};

export type AutoReplySettingsReader = (
  tx: DbTransaction,
  brandId: string,
  channel: TicketChannel,
) => Promise<AutoReplySettings | null>;

// TODO(M7-06): bind to the brand's assistant modes once M7-10's settings land.
export const readAutoReplySettings: AutoReplySettingsReader = () => Promise.resolve(null);
