import type { MergedInto, MergedTicket, TicketMessage } from '@helpdock/schemas';
import { Box, Button, Link as MuiLink, Typography } from '@mui/material';
import { GitMerge, Undo2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useT } from '../../app/i18n.js';
import { usePreferences } from '../../app/providers.tsx';
import { ticketRoute } from '../../app/route-paths.js';
import { useSemanticTokens } from '../../app/tokens.js';
import { unmergeHoursLeft } from '../../tickets/merge.js';
import { AttachmentChip, chipState } from './attachment-chip.tsx';
import { isolate, messageTime, ticketReference } from './format.js';
import type { ThreadNames } from './thread.tsx';

/**
 * A merged ticket in the thread — panel 7 of `AdminTicketDialogs` (M1-09,
 * DOMAIN-RULES §2.4, DESIGN §6.3 MergedThread).
 *
 * On the **primary**: a banner saying which ticket was merged in, by whom and
 * when, with Unmerge while its 24 hours last; a divider naming where the
 * messages below it come from; and those messages on `bg.canvas`, read-only,
 * each marked with its origin. They are not bubbles: nothing here can be
 * replied to, and drawing them as bubbles would say otherwise.
 *
 * On the **secondary**: the same banner the other way round, "Merged into
 * HD-1038", and the workspace draws no composer under it.
 */

export function MergedBlock({
  merged,
  intoReference,
  names,
  now,
  busy,
  onUnmerge,
}: {
  readonly merged: MergedTicket;
  /**
   * The ticket it went into, when that is not the one being read — a chain,
   * A into B and B into this one. `null` reads "into this ticket".
   */
  readonly intoReference: string | null;
  readonly names: ThreadNames;
  readonly now: number;
  readonly busy: boolean;
  onUnmerge(ticketId: string): void;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const { locale } = usePreferences();
  const reference = ticketReference(merged);
  const by = merged.mergedById === null ? null : names.nameFor('staff', merged.mergedById);
  const time = messageTime(merged.mergedAt, locale, now);

  const sentence =
    intoReference === null
      ? by === null
        ? t('tickets:merged.intoThis', { reference: isolate(reference), time })
        : t('tickets:merged.intoThisBy', { reference: isolate(reference), name: by, time })
      : by === null
        ? t('tickets:merged.intoOther', {
            reference: isolate(reference),
            primary: isolate(intoReference),
            time,
          })
        : t('tickets:merged.intoOtherBy', {
            reference: isolate(reference),
            primary: isolate(intoReference),
            name: by,
            time,
          });

  return (
    <Box
      component="section"
      aria-label={t('tickets:merged.from', { reference })}
      sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}
    >
      <MergeBanner
        text={sentence}
        hoursLeft={unmergeHoursLeft(merged.unmergeableUntil, now)}
        busy={busy}
        onUnmerge={() => {
          onUnmerge(merged.id);
        }}
      />

      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 3,
          '&::before, &::after': {
            content: '""',
            flex: 1,
            height: '1px',
            backgroundColor: tokens['border.default'],
          },
        }}
      >
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          {t('tickets:merged.from', { reference: isolate(reference) })}
        </Typography>
      </Box>

      <Box
        component="ol"
        sx={{
          listStyle: 'none',
          margin: 0,
          padding: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: 3,
        }}
      >
        {merged.messages
          .filter((message) => message.kind !== 'system')
          .map((message) => (
            <Box component="li" key={message.id}>
              <ReadOnlyMessage message={message} reference={reference} names={names} now={now} />
            </Box>
          ))}
      </Box>

      {merged.hasMoreMessages ? (
        <MuiLink component={Link} to={ticketRoute(merged.id)} variant="caption">
          {t('tickets:merged.more', { reference: isolate(reference) })}
        </MuiLink>
      ) : null}
    </Box>
  );
}

/** The secondary's own banner: "Merged into HD-1038", with Unmerge while it lasts. */
export function MergedIntoBanner({
  mergedInto,
  names,
  now,
  busy,
  onUnmerge,
}: {
  readonly mergedInto: MergedInto;
  readonly names: ThreadNames;
  readonly now: number;
  readonly busy: boolean;
  onUnmerge(): void;
}): ReactNode {
  const t = useT();
  const { locale } = usePreferences();
  const reference = ticketReference(mergedInto);
  const by = mergedInto.mergedById === null ? null : names.nameFor('staff', mergedInto.mergedById);
  const time = messageTime(mergedInto.mergedAt, locale, now);

  return (
    <MergeBanner
      text={
        by === null
          ? t('tickets:merged.thisInto', { reference: isolate(reference), time })
          : t('tickets:merged.thisIntoBy', { reference: isolate(reference), name: by, time })
      }
      link={
        <MuiLink component={Link} to={ticketRoute(mergedInto.id)} sx={{ color: 'inherit' }}>
          {t('tickets:merged.open', { reference: isolate(reference) })}
        </MuiLink>
      }
      hoursLeft={unmergeHoursLeft(mergedInto.unmergeableUntil, now)}
      busy={busy}
      onUnmerge={onUnmerge}
    />
  );
}

/** DESIGN §6.4 Banner in the info tint, with the Unmerge button at its inline end. */
function MergeBanner({
  text,
  link,
  hoursLeft,
  busy,
  onUnmerge,
}: {
  readonly text: string;
  readonly link?: ReactNode;
  /** Null once the merge can no longer be undone, which is when the button goes. */
  readonly hoursLeft: number | null;
  readonly busy: boolean;
  onUnmerge(): void;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();

  return (
    <Box
      role="status"
      sx={{
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 3,
        paddingBlock: 2,
        paddingInline: 3,
        borderRadius: '6px',
        backgroundColor: tokens['status.info.tint'],
        border: `1px solid ${tokens['status.info']}`,
        color: tokens['status.info.text'],
      }}
    >
      <GitMerge size={16} aria-hidden="true" style={{ flexShrink: 0 }} />
      <Typography variant="body2" sx={{ flex: 1, minWidth: 0, fontSize: 13, color: 'inherit' }}>
        {text}
        {link === undefined ? null : (
          <>
            {' · '}
            {link}
          </>
        )}
      </Typography>
      {hoursLeft === null ? null : (
        <Button
          variant="outlined"
          size="small"
          disabled={busy}
          startIcon={<Undo2 size={14} aria-hidden="true" />}
          onClick={onUnmerge}
          sx={{ backgroundColor: tokens['bg.surface'] }}
        >
          {t('tickets:merged.unmerge', { hours: hoursLeft })}
        </Button>
      )}
    </Box>
  );
}

/** Who a message is from when the directory cannot name them. */
const FALLBACK_AUTHOR = {
  staff: 'staff',
  contact: 'contact',
  ai: 'ai',
  system: 'system',
} as const;

/** One message of a merged ticket: on `bg.canvas`, marked with where it came from. */
function ReadOnlyMessage({
  message,
  reference,
  names,
  now,
}: {
  readonly message: TicketMessage;
  readonly reference: string;
  readonly names: ThreadNames;
  readonly now: number;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const { locale } = usePreferences();
  const author =
    names.nameFor(message.authorType, message.authorId) ??
    t(`tickets:thread.${FALLBACK_AUTHOR[message.authorType]}`);

  return (
    <Box
      component="article"
      sx={{
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        paddingBlock: 3,
        paddingInline: 4,
        borderRadius: '10px',
        backgroundColor: tokens['bg.canvas'],
        border: `1px solid ${tokens['border.default']}`,
      }}
    >
      <Typography variant="caption" component="p" sx={{ color: 'text.secondary' }}>
        <Box component="span" sx={{ fontWeight: 500, color: 'text.primary' }}>
          {author}
        </Box>
        {message.kind === 'note' ? ` · ${t('tickets:thread.note')}` : null}
        {' · '}
        <bdi>{messageTime(message.createdAt, locale, now)}</bdi>
        {' · '}
        <Typography variant="mono" component="bdi" sx={{ fontSize: 12 }}>
          {reference}
        </Typography>
      </Typography>
      <Box
        sx={{
          fontSize: 14,
          lineHeight: '22px',
          wordBreak: 'break-word',
          '& p': { margin: 0, marginBlockEnd: 2 },
          '& p:last-child': { marginBlockEnd: 0 },
          '& a': { color: tokens['text.link'] },
        }}
        // biome-ignore lint/security/noDangerouslySetInnerHtml: `body_html` is sanitised by the api before it is stored (ADR 0007), as for every bubble.
        dangerouslySetInnerHTML={{ __html: message.bodyHtml }}
      />
      {message.attachments.length === 0 ? null : (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2 }}>
          {message.attachments.map((attachment) => (
            <AttachmentChip
              key={attachment.id}
              name={attachment.originalName}
              size={attachment.size}
              state={chipState(attachment)}
            />
          ))}
        </Box>
      )}
    </Box>
  );
}
