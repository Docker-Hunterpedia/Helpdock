import type {
  ChannelsRefusal,
  ContentPolicy,
  ImapTestRequest,
  ImapTestResult,
  InboundParseSecret,
  InboundParseSettings,
  Mailbox,
  MailboxCreateRequest,
  MailboxList,
  MailboxUpdateRequest,
  WebFormSettings,
  WebFormSettingsUpdate,
  WidgetAccessUpdate,
  WidgetAppearance,
  WidgetConversationSettings,
  WidgetSettings,
  WidgetSignedIdentity,
  WidgetSigningSecret,
} from '@helpdock/schemas';

/**
 * Everything Channels › Mailboxes, Channels › Web form and the thread's email
 * card need (M2-02, M2-03, M2-07, M2-08, M4-09). `MockChannelsApi` is the fixture the unit tests and the
 * mock Playwright projects run against; `HttpChannelsApi` is the real service.
 * The same shape as `TicketingApi`: one interface, two adapters, and refusals
 * that cross as a code the screen picks a sentence for.
 */
export interface ChannelsApi {
  mailboxes(brandId: string): Promise<MailboxList>;
  mailbox(brandId: string, mailboxId: string): Promise<Mailbox>;
  createMailbox(brandId: string, request: MailboxCreateRequest): Promise<Mailbox>;
  updateMailbox(
    brandId: string,
    mailboxId: string,
    request: MailboxUpdateRequest,
  ): Promise<Mailbox>;
  deleteMailbox(brandId: string, mailboxId: string): Promise<void>;
  /** "Test IMAP": answers with what the server said, never throws for a refusal. */
  testImap(brandId: string, request: ImapTestRequest): Promise<ImapTestResult>;

  inboundParse(brandId: string): Promise<InboundParseSettings>;
  /** "Replace": the new secret, which the screen shows once. */
  replaceInboundSecret(brandId: string): Promise<InboundParseSecret>;

  /**
   * One remote image of an email, through the api's proxy (M2-07), as a
   * `data:` URL: the admin's CSP allows `data:` images and nothing remote, and
   * the proxy needs the access token a plain `<img src>` cannot send.
   */
  remoteImage(brandId: string, ticketId: string, messageId: string, index: number): Promise<string>;

  // Channels › Widget (M4-03, M4-06 to M4-08). One save per card; a Team
  // Leader's view has `access` and `signedIdentity` as null.
  widgetSettings(brandId: string): Promise<WidgetSettings>;
  saveWidgetAppearance(brandId: string, request: WidgetAppearance): Promise<WidgetSettings>;
  saveWidgetConversation(
    brandId: string,
    request: WidgetConversationSettings,
  ): Promise<WidgetSettings>;
  saveWidgetContentPolicy(brandId: string, request: ContentPolicy): Promise<WidgetSettings>;
  saveWidgetAccess(brandId: string, request: WidgetAccessUpdate): Promise<WidgetSettings>;
  saveWidgetSignedIdentity(brandId: string, request: WidgetSignedIdentity): Promise<WidgetSettings>;
  /** "Replace": the new signing secret, which the screen shows once. */
  replaceWidgetSigningSecret(brandId: string): Promise<WidgetSigningSecret>;

  /** Channels › Web form (M4-09). */
  webForm(brandId: string): Promise<WebFormSettings>;
  saveWebForm(brandId: string, request: WebFormSettingsUpdate): Promise<WebFormSettings>;
}

/** Query keys for the Widget tab. */
export const widgetKeys = {
  settings: (brandId: string) => ['channels', brandId, 'widget'] as const,
};

/** Query keys, so a save can refresh exactly what it changed. */
export const channelsKeys = {
  webForm: (brandId: string) => ['channels', brandId, 'web-form'] as const,
};

export class ChannelsError extends Error {
  readonly reason: ChannelsRefusal;

  constructor(reason: ChannelsRefusal) {
    super(`channels: ${reason}`);
    this.name = 'ChannelsError';
    this.reason = reason;
  }
}

export const isChannelsError = (error: unknown): error is ChannelsError =>
  error instanceof ChannelsError;

/** A `Blob` as a `data:` URL, for the reason {@link ChannelsApi.remoteImage} gives. */
export const blobToDataUrl = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve(String(reader.result));
    };
    reader.onerror = () => {
      reject(reader.error ?? new Error('The image could not be read'));
    };
    reader.readAsDataURL(blob);
  });
