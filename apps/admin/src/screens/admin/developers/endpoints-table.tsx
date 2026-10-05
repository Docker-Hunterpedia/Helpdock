import { WEBHOOK_DELIVERY_ATTEMPTS, WEBHOOK_EVENTS, type WebhookOverview } from '@helpdock/schemas';
import {
  Box,
  ButtonBase,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import { Pencil, Power, PowerOff, Send, Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { useT } from '../../../app/i18n.js';
import { usePreferences } from '../../../app/providers.tsx';
import { useSemanticTokens } from '../../../app/tokens.js';
import { ActionsMenu, type MenuAction } from '../../../ui/actions-menu.tsx';
import { visuallyHidden } from '../../../ui/visually-hidden.js';
import { clockTime } from '../channels/format.js';
import { headCellSx } from './card.tsx';
import { deliveryOutcome, nextRetryAt, relativeTime, successRate } from './format.js';
import { MonoTag } from './mono-tag.tsx';

/**
 * The Endpoints table of `Admin/Developers-Webhooks`: each endpoint's URL, its
 * events, whether it is on, how its last day went and what its newest
 * delivery came to. The URL opens the endpoint below; the row Menu holds the
 * rest.
 */

export interface EndpointActions {
  onOpen(webhook: WebhookOverview): void;
  onTest(webhook: WebhookOverview): void;
  onEdit(webhook: WebhookOverview): void;
  onToggle(webhook: WebhookOverview): void;
  onDelete(webhook: WebhookOverview): void;
}

const SHOWN_EVENTS = 2;

export function EndpointsTable({
  webhooks,
  selectedId,
  actions,
}: {
  readonly webhooks: readonly WebhookOverview[];
  readonly selectedId: string | null;
  readonly actions: EndpointActions;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const head = headCellSx(tokens);

  return (
    <TableContainer>
      <Table size="small" aria-label={t('developers:webhooks.tableLabel')} sx={{ minWidth: 880 }}>
        <TableHead>
          <TableRow sx={{ height: 36, backgroundColor: tokens['bg.muted'] }}>
            <TableCell sx={head}>{t('developers:webhooks.columns.url')}</TableCell>
            <TableCell sx={head}>{t('developers:webhooks.columns.events')}</TableCell>
            <TableCell sx={head}>{t('developers:webhooks.columns.status')}</TableCell>
            <TableCell sx={{ ...head, textAlign: 'end' }}>
              {t('developers:webhooks.columns.successRate')}
            </TableCell>
            <TableCell sx={head}>{t('developers:webhooks.columns.lastDelivery')}</TableCell>
            <TableCell sx={head}>
              <Box component="span" sx={visuallyHidden}>
                {t('developers:webhooks.columns.actions')}
              </Box>
            </TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {webhooks.map((webhook) => (
            <EndpointRow
              key={webhook.id}
              webhook={webhook}
              selected={webhook.id === selectedId}
              actions={actions}
            />
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

function EndpointRow({
  webhook,
  selected,
  actions,
}: {
  readonly webhook: WebhookOverview;
  readonly selected: boolean;
  readonly actions: EndpointActions;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const { locale } = usePreferences();
  const rate = successRate(webhook.last24h, locale);
  const caption = { fontSize: 12, color: 'text.secondary', display: 'block' } as const;
  const mono = { fontFamily: 'var(--hd-font-mono, monospace)', fontSize: 13 } as const;

  const menu: MenuAction[] = [
    {
      id: 'test',
      label: t('developers:webhooks.menu.test'),
      icon: Send,
      onSelect: () => {
        actions.onTest(webhook);
      },
    },
    {
      id: 'edit',
      label: t('developers:webhooks.menu.edit'),
      icon: Pencil,
      onSelect: () => {
        actions.onEdit(webhook);
      },
    },
    {
      id: 'toggle',
      label: t(
        webhook.enabled ? 'developers:webhooks.menu.turnOff' : 'developers:webhooks.menu.turnOn',
      ),
      icon: webhook.enabled ? PowerOff : Power,
      onSelect: () => {
        actions.onToggle(webhook);
      },
    },
    {
      id: 'delete',
      label: t('developers:webhooks.menu.delete'),
      icon: Trash2,
      tone: 'danger',
      dividerBefore: true,
      onSelect: () => {
        actions.onDelete(webhook);
      },
    },
  ];

  return (
    <TableRow
      aria-selected={selected}
      sx={{
        height: 56,
        backgroundColor: selected ? tokens['action.primary.tint'] : undefined,
      }}
    >
      <TableCell
        sx={{
          maxWidth: 320,
          borderInlineStart: `3px solid ${selected ? tokens['action.primary'] : 'transparent'}`,
        }}
      >
        <ButtonBase
          onClick={() => {
            actions.onOpen(webhook);
          }}
          aria-label={t('developers:webhooks.open', { url: webhook.url })}
          sx={{ borderRadius: '4px', maxWidth: '100%' }}
        >
          <Box
            component="span"
            dir="ltr"
            title={webhook.url}
            sx={{
              ...mono,
              fontWeight: 500,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {webhook.url}
          </Box>
        </ButtonBase>
      </TableCell>
      <TableCell>
        <EventTags events={webhook.events} />
      </TableCell>
      <TableCell>
        <StateBadge enabled={webhook.enabled} />
      </TableCell>
      <TableCell sx={{ textAlign: 'end', whiteSpace: 'nowrap' }}>
        <Box component="span" sx={{ ...mono, display: 'block' }}>
          {rate ?? '—'}
        </Box>
        <Typography component="span" sx={caption}>
          {rate === null
            ? t('developers:webhooks.noDeliveries')
            : t('developers:webhooks.rateOf', {
                succeeded: webhook.last24h.succeeded,
                total: webhook.last24h.total,
              })}
        </Typography>
      </TableCell>
      <TableCell sx={{ whiteSpace: 'nowrap' }}>
        <LastDelivery webhook={webhook} />
      </TableCell>
      <TableCell sx={{ textAlign: 'end' }}>
        <ActionsMenu
          items={menu}
          label={t('developers:webhooks.actionsFor', { url: webhook.url })}
          menuLabel={t('developers:webhooks.actionsFor', { url: webhook.url })}
        />
      </TableCell>
    </TableRow>
  );
}

/** The newest delivery's answer, and when — or which attempt is next. */
function LastDelivery({
  webhook: { lastDelivery },
}: {
  readonly webhook: WebhookOverview;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const { locale } = usePreferences();
  const caption = { fontSize: 12, color: 'text.secondary', display: 'block' } as const;
  const mono = { fontFamily: 'var(--hd-font-mono, monospace)', fontSize: 13 } as const;

  if (lastDelivery === null) {
    return (
      <Typography component="span" sx={caption}>
        {t('developers:webhooks.lastNever')}
      </Typography>
    );
  }
  const outcome = deliveryOutcome(lastDelivery);
  const code =
    lastDelivery.responseStatus === null
      ? t(`developers:webhooks.outcome.${outcome}`)
      : String(lastDelivery.responseStatus);
  const attemptedAt = lastDelivery.lastAttemptAt ?? lastDelivery.createdAt;
  const when = relativeTime(attemptedAt, Date.now(), locale);
  const retrying = nextRetryAt(lastDelivery) !== null;
  const tone = outcome === 'delivered' ? 'text.primary' : 'status.danger.text';

  return (
    <>
      <Box component="span" sx={{ display: 'block', fontSize: 13, color: tokens[tone] }}>
        <Box component="span" sx={lastDelivery.responseStatus === null ? {} : mono}>
          {code}
        </Box>
        {retrying ? ` · ${t('developers:webhooks.retrying')}` : null}
      </Box>
      <Typography component="span" sx={caption}>
        {retrying
          ? t('developers:webhooks.attemptAt', {
              attempt: lastDelivery.attempts,
              max: WEBHOOK_DELIVERY_ATTEMPTS,
              time: clockTime(attemptedAt, locale),
            })
          : lastDelivery.status === 'failed'
            ? t('developers:webhooks.gaveUp', { when, max: WEBHOOK_DELIVERY_ATTEMPTS })
            : when}
      </Typography>
    </>
  );
}

/** The first two events and "+n", or "All 7 events". */
export function EventTags({ events }: { readonly events: readonly string[] }): ReactNode {
  const t = useT();
  if (events.length === WEBHOOK_EVENTS.length) {
    return <MonoTag prose>{t('developers:webhooks.allEvents', { n: events.length })}</MonoTag>;
  }
  const shown = events.slice(0, SHOWN_EVENTS);
  const rest = events.length - shown.length;

  return (
    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, alignItems: 'center' }}>
      {shown.map((event) => (
        <MonoTag key={event}>{event}</MonoTag>
      ))}
      {rest > 0 ? (
        <Typography
          component="span"
          title={events.slice(SHOWN_EVENTS).join(', ')}
          sx={{ fontSize: 12, color: 'text.secondary' }}
        >
          {t('developers:webhooks.moreEvents', { n: rest })}
        </Typography>
      ) : null}
    </Box>
  );
}

/** DESIGN §6.2 StatusBadge: Active in success, Turned off in danger, a dot and the word. */
export function StateBadge({ enabled }: { readonly enabled: boolean }): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const tone = enabled ? 'success' : 'danger';

  return (
    <Box
      component="span"
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 1,
        height: 22,
        paddingInline: 2,
        borderRadius: '999px',
        backgroundColor: tokens[`status.${tone}.tint`],
        color: tokens[`status.${tone}.text`],
        fontSize: 12,
        fontWeight: 500,
        whiteSpace: 'nowrap',
      }}
    >
      <Box
        component="span"
        aria-hidden="true"
        sx={{ width: 6, height: 6, borderRadius: '50%', backgroundColor: tokens[`status.${tone}`] }}
      />
      {t(enabled ? 'developers:webhooks.active' : 'developers:webhooks.turnedOff')}
    </Box>
  );
}
