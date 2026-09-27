import { type EmailMessageView, emailMessageMetaSchema, remoteImageHosts } from '@helpdock/schemas';

/**
 * `ticket_messages.email` to what the thread's email card reads (M2-04,
 * M2-07). The remote image URLs stay behind: the card needs how many and from
 * where, and fetches each one through the proxy by index, so a URL a sender
 * chose never reaches an agent's browser.
 *
 * A row that does not parse — written by a later version, or damaged — draws
 * as a plain bubble rather than failing the whole thread.
 */
export const toEmailView = (stored: unknown): EmailMessageView | undefined => {
  const parsed = emailMessageMetaSchema.safeParse(stored);
  if (!parsed.success) {
    return undefined;
  }

  const meta = parsed.data;
  return {
    from: meta.from,
    to: meta.to,
    cc: meta.cc,
    date: meta.date,
    quotedHtml: meta.quotedHtml,
    remoteImages: {
      count: meta.remoteImages.length,
      hosts: remoteImageHosts(meta.remoteImages),
      policy: meta.remoteImagePolicy,
    },
    inlineAttachmentIds: meta.inlineAttachmentIds,
    authFailed: meta.authFailed,
    mismatch: meta.mismatch,
  };
};
