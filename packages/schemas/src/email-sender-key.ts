import { z } from 'zod';

/** The key of the mailbox a rule chose for a ticket's replies (M14-26): `mailbox:<id>`. */
export const mailboxSenderKey = (mailboxId: string): `mailbox:${string}` => `mailbox:${mailboxId}`;

/**
 * `default`, a department id, or `mailbox:<id>` (M14-26): which sender a reply
 * goes out as. The mailbox key is only honoured for the ticket's own reply mailbox.
 */
export const emailSenderKeySchema = z.union([
  z.literal('default'),
  z.uuid(),
  z.templateLiteral(['mailbox:', z.uuid()]),
]);
export type EmailSenderKey = z.infer<typeof emailSenderKeySchema>;
