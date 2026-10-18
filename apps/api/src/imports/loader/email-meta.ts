import { emailMessageMetaSchema, type ImportMessage } from '@helpdock/schemas';

/** The thread uses the same stored metadata shape for imports and live mail, with remote images blocked. */
export function importEmailMeta(message: ImportMessage) {
  const email = message.email;
  if (!email?.from) return null;
  const address = (emailAddress: string) => ({ address: emailAddress, name: null });
  return emailMessageMetaSchema.parse({
    from: address(email.from),
    to: (email.to ?? []).map(address),
    cc: (email.cc ?? []).map(address),
    date: email.sentAt === null ? null : new Date(email.sentAt ?? message.createdAt).toISOString(),
    quotedHtml: null,
    remoteImages: [],
    remoteImagePolicy: 'block',
    inlineAttachmentIds: [],
    authFailed: false,
    mismatch: null,
  });
}
