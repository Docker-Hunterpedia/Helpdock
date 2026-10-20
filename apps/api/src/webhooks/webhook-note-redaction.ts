/** Apply per endpoint before persisting, replaying or signing a delivery. */
export const redactWebhookNotes = (
  envelope: Record<string, unknown>,
  includeInternalNotes: boolean,
): Record<string, unknown> => {
  if (includeInternalNotes || envelope.event !== 'message.created') return envelope;
  const data = envelope.data as Record<string, unknown> | undefined;
  const message = data?.message as Record<string, unknown> | undefined;
  if (message?.public !== false) return envelope;
  const { bodyHtml: _html, bodyText: _text, ...metadata } = message;
  return { ...envelope, data: { ...data, message: metadata } };
};
