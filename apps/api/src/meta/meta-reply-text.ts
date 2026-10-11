import { splitMetaText } from '@helpdock/channels';
import type { MetaPlatform } from '@helpdock/schemas';

/**
 * A reply's text as the messages it becomes (M10-06): the opening line, a
 * newline and the agent's words, cut at the platform's limit. The line comes
 * first and is part of what is cut, so it counts toward the limit and only the
 * first message carries it. A reply with no words of its own (files only) is the
 * line alone, as a message of its own, so the customer still sees who wrote.
 */
export const replyTextParts = ({
  platform,
  openingLine,
  bodyText,
}: {
  readonly platform: MetaPlatform;
  readonly openingLine: string;
  readonly bodyText: string;
}): string[] => {
  const words = bodyText.trim();

  return splitMetaText(words === '' ? openingLine : `${openingLine}\n${words}`, platform);
};
