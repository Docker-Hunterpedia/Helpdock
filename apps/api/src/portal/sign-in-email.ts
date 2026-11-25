import { COLOURS, type EmailMessage, escapeHtml } from '@helpdock/channels';
import {
  decryptSecret,
  encryptSecret,
  type Keyring,
  SecretDecryptionError,
} from '@helpdock/config';
import { brands, type Db, type DbTransaction } from '@helpdock/db';
import { createI18n, type Locale } from '@helpdock/i18n';
import {
  createJobProcessor,
  enqueueOutbox,
  type JobHandler,
  type JobLogger,
  type OutboxEventHandler,
  type PortalSignInEmailPayload,
  portalSignInEmailJob,
  portalSignInEmailJobId,
  silentLogger,
} from '@helpdock/jobs';
import { fontFallbacks } from '@helpdock/ui/resolve';
import { type Job, UnrecoverableError } from 'bullmq';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { EmailRepository } from '../email/email.repository.js';
import { resolveSender } from '../email/outgoing-settings.js';
import {
  brandSmtpServer,
  type InstallSmtp,
  type SmtpTransportFactory,
} from '../email/transport.js';
import { translator } from '../help-center/site/render/text.js';

/**
 * The sign-in email of artboard `Email/Portal-SignIn` (M21-02): the request
 * becomes one `portal.sign_in_requested` outbox row, the worker's
 * `portal.sign_in_email` job renders it in the page's language and sends it.
 * Nothing here talks to a mail server while a request waits (DOMAIN-RULES §6).
 *
 * The address and the link are sealed together under `APP_MASTER_KEY` before
 * they reach the outbox: the link is a working credential and the address is the
 * customer's. The job opens them only to build the message and never logs
 * either. No ticket content goes in the email.
 */

export const PORTAL_SIGN_IN_EVENT = 'portal.sign_in_requested';

const eventSchema = z.object({ locale: z.enum(['en', 'ar']), sealed: z.string().min(1) });
const sealedSchema = z.object({ to: z.string().min(3), url: z.string().min(10) });

/** Queues the email in the caller's transaction. */
export const queueSignInEmail = async (
  tx: DbTransaction,
  keyring: Keyring,
  input: { brandId: string; to: string; url: string; locale: Locale },
): Promise<void> => {
  await enqueueOutbox(tx, {
    brandId: input.brandId,
    event: PORTAL_SIGN_IN_EVENT,
    payload: {
      locale: input.locale,
      sealed: encryptSecret(JSON.stringify({ to: input.to, url: input.url }), keyring),
    },
  });
};

export interface SignInEmailQueue {
  add(jobId: string, payload: PortalSignInEmailPayload): Promise<void>;
}

export const createSignInEmailEventHandler =
  (queue: SignInEmailQueue): OutboxEventHandler =>
  async ({ outboxId, brandId, payload }) => {
    const event = eventSchema.parse(payload);
    await queue.add(portalSignInEmailJobId(outboxId), {
      ...event,
      brandId,
      sourceOutboxId: outboxId,
    });
  };

export interface SignInEmailCopy {
  readonly locale: Locale;
  readonly brandName: string;
  readonly address: string;
  readonly url: string;
}

const ACCENT = '#0F766E';

/** The message of the artboard, both parts, from the `email.portalSignIn` and `hcSite.siteName` catalogs. */
export const renderSignInEmail = (
  copy: SignInEmailCopy,
): Pick<EmailMessage, 'subject' | 'text' | 'html' | 'locale'> => {
  const t = createI18n({ lng: copy.locale }).getFixedT(copy.locale, 'email');
  const site = translator(copy.locale)('siteName.public', { brand: copy.brandName });
  const dir = copy.locale === 'ar' ? 'rtl' : 'ltr';
  const values = { site, email: copy.address };
  const subject = t('portalSignIn.subject', values);
  const body = t('portalSignIn.body', values);
  const action = t('portalSignIn.action');
  const ignore = t('portalSignIn.ignore');
  const initial = escapeHtml(Array.from(copy.brandName.trim())[0]?.toUpperCase() ?? 'H');
  const bodyHtml = escapeHtml(body).replace(
    escapeHtml(copy.address),
    `<bdi dir="ltr" style="font-weight:600">${escapeHtml(copy.address)}</bdi>`,
  );

  const html = [
    `<!doctype html><html lang="${copy.locale}" dir="${dir}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>`,
    `<body style="margin:0;padding:24px 0;background:${COLOURS.page};font-family:${fontFallbacks.sans};color:${COLOURS.text}">`,
    `<table role="presentation" dir="${dir}" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%;margin:0 auto;background:${COLOURS.surface};border:1px solid ${COLOURS.border};border-radius:10px;border-collapse:separate">`,
    `<tr><td style="padding:20px 32px;border-bottom:1px solid ${COLOURS.divider}"><span style="display:inline-block;width:32px;height:32px;line-height:32px;border-radius:6px;background:${ACCENT};color:#FFFFFF;font-weight:600;text-align:center;vertical-align:middle">${initial}</span>&nbsp;&nbsp;<span style="font-weight:600;font-size:16px;vertical-align:middle">${escapeHtml(site)}</span></td></tr>`,
    `<tr><td style="padding:24px 32px;font-size:16px;line-height:24px"><p style="margin:0 0 20px 0">${bodyHtml}</p><p style="margin:0 0 20px 0"><a href="${escapeHtml(copy.url)}" style="display:inline-block;padding:12px 20px;border-radius:6px;background:${ACCENT};color:#FFFFFF;font-weight:500;text-decoration:none">${escapeHtml(action)}</a></p><p style="margin:0;font-size:13px;line-height:20px;color:${COLOURS.secondary}">${escapeHtml(ignore)}</p></td></tr>`,
    '</table></body></html>',
  ].join('');
  const text = [body, '', copy.url, '', ignore].join('\n');

  return { subject, text, html, locale: copy.locale };
};

/** Raised when there is nowhere to send through; retried, then dead-lettered. */
export class NoPortalSenderError extends Error {
  constructor() {
    super('No SMTP server or sender is configured for this brand or the install.');
    this.name = 'NoPortalSenderError';
  }
}

export interface SignInEmailWorkerDeps {
  readonly repository: Pick<EmailRepository, 'settings'>;
  readonly keyring: Keyring;
  readonly installSmtp: InstallSmtp;
  readonly transports: SmtpTransportFactory;
}

export const createSignInEmailHandler =
  ({
    repository,
    keyring,
    installSmtp,
    transports,
  }: SignInEmailWorkerDeps): JobHandler<PortalSignInEmailPayload> =>
  async ({ payload, tx, log, brandId }) => {
    let sealed: z.infer<typeof sealedSchema>;
    try {
      sealed = sealedSchema.parse(JSON.parse(decryptSecret(payload.sealed, keyring)));
    } catch (error) {
      if (error instanceof SecretDecryptionError || error instanceof z.ZodError) {
        throw new UnrecoverableError('The sign-in email envelope could not be opened.');
      }
      throw error;
    }
    const [brand] = await tx
      .select({ name: brands.name, status: brands.status })
      .from(brands)
      .where(eq(brands.id, brandId))
      .limit(1);
    if (brand === undefined || brand.status !== 'active') {
      log.info({ brandId }, 'portal sign-in email not sent: the brand is not active');
      return;
    }

    const settings = await repository.settings(tx, brandId);
    const install = await installSmtp.read();
    const server = brandSmtpServer(settings, keyring) ?? install?.server;
    // A sign-in link has no department; the brand's default sender, then the install's.
    const sender = resolveSender(settings, { departmentId: '' }, install?.from);
    if (server === undefined || sender === undefined) {
      throw new NoPortalSenderError();
    }

    const message = renderSignInEmail({
      locale: payload.locale,
      brandName: brand.name,
      address: sealed.to,
      url: sealed.url,
    });
    const transport = transports(server, sender.from);
    try {
      await transport.send({
        ...message,
        to: { address: sealed.to },
        ...(sender.replyTo === null ? {} : { replyTo: sender.replyTo }),
        headers: { 'Auto-Submitted': 'auto-generated' },
      });
    } finally {
      transport.close();
    }
    // Never the address or the link: the log is read by more people than the mailbox.
    log.info({ brandId, locale: payload.locale }, 'portal sign-in email sent');
  };

export const createSignInEmailProcessor = (
  deps: SignInEmailWorkerDeps,
  { db, log = silentLogger }: { readonly db: Db; readonly log?: JobLogger | undefined },
): ((job: Job) => Promise<void>) =>
  createJobProcessor(portalSignInEmailJob, createSignInEmailHandler(deps), { db, log });
