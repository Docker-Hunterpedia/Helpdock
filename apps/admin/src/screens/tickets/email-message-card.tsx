import type { Attachment, EmailMessageView, TicketMessage } from '@helpdock/schemas';
import { Box, Button, Link as MuiLink, Typography } from '@mui/material';
import { ChevronDown, ChevronUp, Image, ImageOff, Link2, Mail, ShieldAlert } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useT } from '../../app/i18n.js';
import { usePreferences } from '../../app/providers.tsx';
import { ticketRoute } from '../../app/route-paths.js';
import { useSemanticTokens } from '../../app/tokens.js';
import { currentBrand, useChannelsApi, useSession } from '../../auth/session.tsx';
import { initialsOf } from '../contacts/format.js';
import { AttachmentChip, chipState } from './attachment-chip.tsx';
import { messageTime } from './format.js';
import { MESSAGE_MAX_WIDTH, SystemEvent } from './message-bubble.tsx';

/**
 * DESIGN §6.3 EmailMessage: a customer's email in the thread, as the
 * `Admin · ticket email` artboard draws it (M2-04, M2-07).
 *
 * - **A header strip** on `bg.canvas`: mail icon, sender, address, time, and
 *   the To and Cc lines, because on email who else was written to matters.
 * - **The body**, sanitised and stored without its quoted history, remote
 *   images and inline images (`body.ts` in `@helpdock/channels`). It is set as
 *   HTML for the reason `MessageBubble` gives.
 * - **Remote images** are never in the body. Under the mailbox's `block`
 *   policy a bar says how many and from where, and "Load images" fetches each
 *   through the api's proxy; under `proxy` they load at once. Either way they
 *   arrive as `data:` URLs from the proxy, never from the sender's server.
 * - **Inline images** are drawn as figures from their attachment rows.
 * - **Show quoted text** expands the history the reply was cut from.
 */

export function EmailMessageCard({
  message,
  email,
  author,
  time,
  body,
  facts,
}: {
  readonly message: TicketMessage;
  readonly email: EmailMessageView;
  readonly author: string;
  readonly time: string;
  /** M7-05, M7-08: drawn instead of the body — a translation, or what the model received. */
  readonly body?: ReactNode;
  /** M7-05, M7-08: the AI facts line under the body. */
  readonly facts?: ReactNode;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const [quoted, setQuoted] = useState(false);
  const inline = new Set(email.inlineAttachmentIds);
  const figures = message.attachments.filter((attachment) => inline.has(attachment.id));
  const files = message.attachments.filter((attachment) => !inline.has(attachment.id));
  const addresses = (list: EmailMessageView['to']): string =>
    list.map((entry) => entry.address).join(', ');

  return (
    <Box
      component="article"
      aria-label={t('tickets:email.label', { name: author })}
      sx={{
        display: 'flex',
        gap: '10px',
        maxWidth: MESSAGE_MAX_WIDTH,
        alignSelf: 'flex-start',
        width: '100%',
      }}
    >
      <Box
        component="span"
        aria-hidden="true"
        sx={{
          width: 32,
          height: 32,
          borderRadius: '999px',
          backgroundColor: tokens['border.default'],
          color: 'text.primary',
          fontSize: 12,
          fontWeight: 600,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        {initialsOf(author)}
      </Box>
      <Box
        sx={{
          flexGrow: 1,
          minWidth: 0,
          borderRadius: '10px',
          border: `1px solid ${tokens['border.default']}`,
          backgroundColor: tokens['bg.surface'],
          overflow: 'hidden',
        }}
      >
        <Box
          sx={{
            paddingBlock: 2,
            paddingInline: 3,
            backgroundColor: tokens['bg.canvas'],
            borderBlockEnd: `1px solid ${tokens['bg.muted']}`,
            display: 'flex',
            flexDirection: 'column',
            gap: '2px',
            fontSize: 12,
            lineHeight: '16px',
            color: 'text.secondary',
          }}
        >
          <Box sx={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
            <Mail size={14} aria-hidden="true" />
            <Typography
              component="strong"
              sx={{ color: 'text.primary', fontWeight: 500, fontSize: 13 }}
            >
              {author}
            </Typography>
            <bdi>{`<${email.from.address}>`}</bdi>
            <Box component="span" sx={{ marginInlineStart: 'auto', whiteSpace: 'nowrap' }}>
              <bdi>{time}</bdi>
            </Box>
          </Box>
          {email.to.length === 0 && email.cc.length === 0 ? null : (
            <Box>
              {email.to.length === 0 ? null : (
                <bdi>{t('tickets:email.toLine', { addresses: addresses(email.to) })}</bdi>
              )}
              {email.to.length > 0 && email.cc.length > 0 ? ' · ' : null}
              {email.cc.length === 0 ? null : (
                <bdi>{t('tickets:email.ccLine', { addresses: addresses(email.cc) })}</bdi>
              )}
            </Box>
          )}
        </Box>

        <Box
          sx={{
            paddingBlock: '10px',
            paddingInline: 3,
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
          }}
        >
          {email.authFailed ? (
            <Typography
              variant="caption"
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 1,
                color: tokens['status.warning.text'],
              }}
            >
              <ShieldAlert size={14} aria-hidden="true" />
              {t('tickets:email.authFailed')}
            </Typography>
          ) : null}

          {body === undefined ? (
            <Box
              sx={{
                fontSize: 14,
                lineHeight: '20px',
                wordBreak: 'break-word',
                '& p': { margin: 0, marginBlockEnd: 2 },
                '& p:last-child': { marginBlockEnd: 0 },
                '& a': { color: tokens['text.link'] },
              }}
              // biome-ignore lint/security/noDangerouslySetInnerHtml: `body_html` is sanitised by the api before it is stored (ADR 0007), with every image taken out; see `MessageBubble`.
              dangerouslySetInnerHTML={{ __html: message.bodyHtml }}
            />
          ) : (
            <Box sx={{ lineHeight: '20px', wordBreak: 'break-word' }}>{body}</Box>
          )}
          {facts}

          {email.remoteImages.count === 0 ? null : (
            <RemoteImages ticketId={message.ticketId} messageId={message.id} email={email} />
          )}

          {figures.length === 0 && files.length === 0 ? null : (
            <Box sx={{ display: 'flex', alignItems: 'flex-end', gap: '10px', flexWrap: 'wrap' }}>
              {figures.map((attachment) => (
                <InlineFigure key={attachment.id} attachment={attachment} />
              ))}
              {files.map((attachment) => (
                <AttachmentChip
                  key={attachment.id}
                  name={attachment.originalName}
                  size={attachment.size}
                  state={chipState(attachment)}
                />
              ))}
            </Box>
          )}

          {email.quotedHtml === null ? null : (
            <>
              <Button
                size="small"
                variant="outlined"
                aria-expanded={quoted}
                startIcon={
                  quoted ? (
                    <ChevronUp size={14} aria-hidden="true" />
                  ) : (
                    <ChevronDown size={14} aria-hidden="true" />
                  )
                }
                onClick={() => {
                  setQuoted((current) => !current);
                }}
                sx={{ alignSelf: 'flex-start', height: 24, fontSize: 12, color: 'text.secondary' }}
              >
                {t(quoted ? 'tickets:email.hideQuoted' : 'tickets:email.showQuoted')}
              </Button>
              {quoted ? (
                <Box
                  sx={{
                    borderInlineStart: `2px solid ${tokens['border.strong']}`,
                    paddingInlineStart: 3,
                    color: 'text.secondary',
                    fontSize: 13,
                    lineHeight: '18px',
                    wordBreak: 'break-word',
                    '& p': { margin: 0, marginBlockEnd: 2 },
                    '& blockquote': { margin: 0 },
                  }}
                  // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitised by the same allowlist as the body, on the way in (ADR 0007).
                  dangerouslySetInnerHTML={{ __html: email.quotedHtml }}
                />
              ) : null}
            </>
          )}
        </Box>
      </Box>
    </Box>
  );
}

/** The artboard's inline figure: an image icon and "name · inline". No thumbnail, as on `AttachmentChip`. */
function InlineFigure({ attachment }: { readonly attachment: Attachment }): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();

  return (
    <Box
      component="figure"
      sx={{
        margin: 0,
        width: 180,
        height: 72,
        borderRadius: '6px',
        border: `1px solid ${tokens['border.default']}`,
        backgroundColor: tokens['bg.muted'],
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 1,
        color: 'text.secondary',
        fontSize: 12,
      }}
    >
      <Image size={20} aria-hidden="true" />
      <Box
        component="figcaption"
        sx={{
          maxWidth: '100%',
          paddingInline: 2,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        <bdi>{t('tickets:email.inline', { name: attachment.originalName })}</bdi>
      </Box>
    </Box>
  );
}

type ImageState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'loaded'; readonly images: readonly (string | null)[] };

/**
 * The remote-images bar and what it loads. Under `proxy` the images load as
 * the card mounts; under `block` only when "Load images" is pressed.
 */
function RemoteImages({
  ticketId,
  messageId,
  email,
}: {
  readonly ticketId: string;
  readonly messageId: string;
  readonly email: EmailMessageView;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const api = useChannelsApi();
  const brand = currentBrand(useSession());
  const [state, setState] = useState<ImageState>({ kind: 'idle' });
  const { count, hosts, policy } = email.remoteImages;

  const load = async (): Promise<void> => {
    setState({ kind: 'loading' });
    const images = await Promise.all(
      Array.from({ length: count }, (_, index) =>
        api.remoteImage(brand.id, ticketId, messageId, index).catch(() => null),
      ),
    );
    setState({ kind: 'loaded', images });
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: loads once per message under the proxy policy.
  useEffect(() => {
    if (policy === 'proxy') {
      void load();
    }
  }, [policy, messageId]);

  if (state.kind === 'loaded') {
    const failed = state.images.some((image) => image === null);

    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2 }}>
          {state.images.map((image, index) =>
            image === null ? null : (
              <Box
                // The order of a message's images never changes, so the index is their identity.
                // biome-ignore lint/suspicious/noArrayIndexKey: see above.
                key={index}
                component="img"
                src={image}
                alt={t('tickets:email.remoteImage', { host: hosts[0] ?? '' })}
                sx={{ maxWidth: '100%', maxHeight: 320, borderRadius: '6px' }}
              />
            ),
          )}
        </Box>
        {failed ? (
          <Typography
            variant="caption"
            sx={{ color: 'text.secondary', display: 'flex', gap: 1, alignItems: 'center' }}
          >
            <ImageOff size={14} aria-hidden="true" />
            {t('tickets:email.imagesFailed')}
          </Typography>
        ) : null}
      </Box>
    );
  }

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        height: 32,
        paddingInlineStart: '10px',
        paddingInlineEnd: 1,
        borderRadius: '6px',
        backgroundColor: tokens['bg.canvas'],
        border: `1px solid ${tokens['border.default']}`,
        fontSize: 12,
        color: 'text.secondary',
      }}
    >
      <ImageOff size={14} aria-hidden="true" />
      <Box
        component="span"
        sx={{
          flexGrow: 1,
          minWidth: 0,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        <bdi>{t('tickets:email.remoteBlocked', { count, hosts: hosts.join(', ') })}</bdi>
      </Box>
      <Button
        size="small"
        variant="outlined"
        disabled={state.kind === 'loading'}
        aria-busy={state.kind === 'loading'}
        onClick={() => {
          void load();
        }}
        sx={{ height: 24, fontSize: 12 }}
      >
        {t(state.kind === 'loading' ? 'tickets:email.loadingImages' : 'tickets:email.loadImages')}
      </Button>
    </Box>
  );
}

/**
 * The system line of DOMAIN-RULES §4.3 as the artboard draws it: "Referenced
 * HD-1042 but sender is not a participant · 15:20", then "Open HD-1042 ·
 * Merge into HD-1042…". Opening it answers 404 for somebody who may not see
 * that ticket, which is the answer they should get.
 */
export function ThreadMismatch({
  message,
  mismatch,
  now,
  onMerge,
}: {
  readonly message: TicketMessage;
  readonly mismatch: NonNullable<EmailMessageView['mismatch']>;
  readonly now: number;
  onMerge?(reference: string): void;
}): ReactNode {
  const t = useT();
  const { locale } = usePreferences();

  return (
    <Box role="note" sx={{ alignSelf: 'center' }}>
      <SystemEvent>
        <Box component="span" sx={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
          <Box
            component="span"
            sx={{ display: 'inline-flex', alignItems: 'center', gap: 1, justifyContent: 'center' }}
          >
            <Link2 size={12} aria-hidden="true" />
            <span>{`${message.bodyText} · ${messageTime(message.createdAt, locale, now)}`}</span>
          </Box>
          <Box component="span">
            <MuiLink component={Link} to={ticketRoute(mismatch.ticketId)}>
              <bdi>{t('tickets:email.mismatch.open', { ticket: mismatch.reference })}</bdi>
            </MuiLink>
            {onMerge === undefined ? null : (
              <>
                {' · '}
                <MuiLink
                  component="button"
                  type="button"
                  onClick={() => {
                    onMerge(mismatch.reference);
                  }}
                  sx={{ fontSize: 'inherit', verticalAlign: 'baseline' }}
                >
                  <bdi>{t('tickets:email.mismatch.merge', { ticket: mismatch.reference })}</bdi>
                </MuiLink>
              </>
            )}
          </Box>
        </Box>
      </SystemEvent>
    </Box>
  );
}
