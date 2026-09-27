import type {
  AutoReplies,
  EmailOutgoingSettings,
  EmailSenders,
  EmailSignature,
  FailedSendList,
  OutgoingSmtpTestResult,
  OutgoingSmtpUpdate,
  TicketEmailContext,
} from '@helpdock/schemas';

/**
 * Everything the outbound email screens need (M2-05, M2-06, M2-08's outbound
 * half): Channels › Outgoing email, the Email signature tab of Your account,
 * and the ticket view's email mode. `MockEmailApi` is the fixture the unit
 * tests and the mock Playwright projects run against; `HttpEmailApi` is the
 * real service. Failures cross as the transport's errors, and every screen
 * answers them with one translated sentence.
 */
export interface EmailApi {
  outgoing(brandId: string): Promise<EmailOutgoingSettings>;
  saveSmtp(brandId: string, request: OutgoingSmtpUpdate): Promise<EmailOutgoingSettings>;
  testSmtp(brandId: string, request: OutgoingSmtpUpdate): Promise<OutgoingSmtpTestResult>;
  saveSenders(brandId: string, request: EmailSenders): Promise<EmailOutgoingSettings>;
  saveAutoReplies(brandId: string, request: AutoReplies): Promise<EmailOutgoingSettings>;

  failedSends(brandId: string): Promise<FailedSendList>;
  retryFailedSend(brandId: string, deliveryId: string): Promise<void>;
  retryAllFailedSends(brandId: string): Promise<number>;
  discardFailedSend(brandId: string, deliveryId: string): Promise<void>;

  signature(): Promise<EmailSignature>;
  saveSignature(request: EmailSignature): Promise<EmailSignature>;

  ticketEmail(brandId: string, ticketId: string): Promise<TicketEmailContext>;
  retryMessage(brandId: string, ticketId: string, messageId: string): Promise<void>;
}

/** Query keys, so a save can refresh exactly what it changed. */
export const emailKeys = {
  outgoing: (brandId: string) => ['email', brandId, 'outgoing'] as const,
  failedSends: (brandId: string) => ['email', brandId, 'failed-sends'] as const,
  signature: () => ['email', 'signature'] as const,
  ticket: (brandId: string, ticketId: string) => ['email', brandId, 'ticket', ticketId] as const,
};
