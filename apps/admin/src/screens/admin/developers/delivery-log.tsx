import {
  WEBHOOK_DELIVERY_ATTEMPTS,
  WEBHOOK_TIMEOUT_MS,
  type WebhookDelivery,
  type WebhookOverview,
} from '@helpdock/schemas';
import {
  Box,
  Button,
  ButtonBase,
  MenuItem,
  Select,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Check, CircleAlert, Clock, MinusCircle } from 'lucide-react';
import { type ReactNode, useEffect, useId, useState } from 'react';
import { useT } from '../../../app/i18n.js';
import { usePreferences } from '../../../app/providers.tsx';
import { useSemanticTokens } from '../../../app/tokens.js';
import { currentBrand, useSession } from '../../../auth/session.tsx';
import { useDevelopersApi } from '../../../developers/context.tsx';
import { clockTime } from '../channels/format.js';
import { Card, CardHeader, headCellSx } from './card.tsx';
import {
  clockSeconds,
  type DeliveryOutcome,
  deliveryFailed,
  deliveryOutcome,
  durationText,
  nextRetryAt,
  relativeTime,
  retryDelayMs,
} from './format.js';

/**
 * DESIGN §6.3 DeliveryLog (M8-03, `Admin/Developers-Webhooks`): one endpoint's
 * deliveries, newest first, with what each attempt came to and what happens
 * next. A row opens its detail beside the log; the retry schedule card under
 * it says what "next" means.
 */

/** While anything in the log is still being retried, it is read again this often. */
const REFRESH_MS = 10_000;

type Filter = 'all' | 'failed' | 'delivered';

export const deliveriesKey = (brandId: string, webhookId: string) =>
  ['developers', 'deliveries', brandId, webhookId] as const;

export function DeliveryLog({
  webhook,
  selectedId,
  onSelect,
}: {
  readonly webhook: WebhookOverview;
  readonly selectedId: string | null;
  onSelect(deliveryId: string): void;
}): ReactNode {
  const t = useT();
  const api = useDevelopersApi();
  const brand = currentBrand(useSession());
  const tokens = useSemanticTokens();
  const headingId = useId();
  const filterId = useId();
  const [filter, setFilter] = useState<Filter>('all');

  const log = useInfiniteQuery({
    queryKey: deliveriesKey(brand.id, webhook.id),
    queryFn: ({ pageParam }) => api.deliveries(brand.id, webhook.id, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    refetchInterval: (query) =>
      query.state.data?.pages.some((page) =>
        page.deliveries.some((delivery) => delivery.status === 'pending'),
      ) === true
        ? REFRESH_MS
        : false,
  });

  const all = log.data?.pages.flatMap((page) => page.deliveries) ?? [];
  const rows = all.filter((delivery) =>
    filter === 'all'
      ? true
      : filter === 'delivered'
        ? delivery.status === 'succeeded'
        : deliveryFailed(delivery),
  );

  const first = all[0]?.id;
  useEffect(() => {
    if (selectedId === null && first !== undefined) {
      onSelect(first);
    }
  }, [selectedId, first, onSelect]);

  const head = headCellSx(tokens);

  return (
    <Card labelledBy={headingId}>
      <CardHeader
        headingId={headingId}
        small
        heading={t('developers:webhooks.log.heading')}
        caption={t('developers:webhooks.log.caption')}
        action={
          <Select
            id={filterId}
            size="small"
            value={filter}
            onChange={(event) => {
              setFilter(event.target.value as Filter);
            }}
            inputProps={{ 'aria-label': t('developers:webhooks.log.filter') }}
            sx={{ height: 28, fontSize: 13 }}
          >
            {(['all', 'failed', 'delivered'] as const).map((value) => (
              <MenuItem key={value} value={value} sx={{ fontSize: 13 }}>
                {t(`developers:webhooks.log.filters.${value}`)}
              </MenuItem>
            ))}
          </Select>
        }
      />
      <TableContainer>
        <Table
          size="small"
          aria-label={t('developers:webhooks.log.tableLabel', { url: webhook.url })}
          sx={{ minWidth: 560 }}
        >
          <TableHead>
            <TableRow sx={{ height: 32, backgroundColor: tokens['bg.muted'] }}>
              <TableCell sx={head}>{t('developers:webhooks.log.columns.event')}</TableCell>
              <TableCell sx={head}>{t('developers:webhooks.log.columns.status')}</TableCell>
              <TableCell sx={{ ...head, textAlign: 'end' }}>
                {t('developers:webhooks.log.columns.attempt')}
              </TableCell>
              <TableCell sx={{ ...head, textAlign: 'end' }}>
                {t('developers:webhooks.log.columns.duration')}
              </TableCell>
              <TableCell sx={head}>{t('developers:webhooks.log.columns.next')}</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((delivery) => (
              <DeliveryRow
                key={delivery.id}
                delivery={delivery}
                selected={delivery.id === selectedId}
                onSelect={() => {
                  onSelect(delivery.id);
                }}
              />
            ))}
            {log.isSuccess && rows.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={5}
                  sx={{ fontSize: 13, color: 'text.secondary', paddingBlock: 4 }}
                >
                  {t(
                    all.length === 0
                      ? 'developers:webhooks.log.empty'
                      : 'developers:webhooks.log.emptyFiltered',
                  )}
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </TableContainer>
      {all.length > 0 ? (
        <Box
          sx={{
            paddingBlock: 2,
            paddingInline: 4,
            display: 'flex',
            alignItems: 'center',
            gap: 2,
            borderBlockStart: `1px solid ${tokens['bg.muted']}`,
          }}
        >
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            {t('developers:webhooks.log.showing', { shown: rows.length })}
          </Typography>
          {log.hasNextPage ? (
            <Button
              size="small"
              variant="text"
              disabled={log.isFetchingNextPage}
              onClick={() => {
                void log.fetchNextPage();
              }}
            >
              {t('developers:webhooks.log.loadMore')}
            </Button>
          ) : null}
        </Box>
      ) : null}
    </Card>
  );
}

function DeliveryRow({
  delivery,
  selected,
  onSelect,
}: {
  readonly delivery: WebhookDelivery;
  readonly selected: boolean;
  onSelect(): void;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const { locale } = usePreferences();
  const time = clockSeconds(delivery.createdAt, locale);
  const mono = { fontFamily: 'var(--hd-font-mono, monospace)', fontSize: 13 };

  return (
    <TableRow
      aria-selected={selected}
      sx={{
        height: 44,
        backgroundColor: selected ? tokens['action.primary.tint'] : undefined,
      }}
    >
      <TableCell
        sx={{
          borderInlineStart: `3px solid ${selected ? tokens['action.primary'] : 'transparent'}`,
        }}
      >
        <ButtonBase
          onClick={onSelect}
          aria-label={t('developers:webhooks.log.openDelivery', { event: delivery.event, time })}
          sx={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-start',
            textAlign: 'start',
            borderRadius: '4px',
          }}
        >
          <Box component="span" dir="ltr" sx={{ ...mono, fontWeight: 500 }}>
            {delivery.event}
          </Box>
          <Typography component="span" variant="caption" sx={{ color: 'text.secondary' }}>
            {delivery.replayOf === null
              ? time
              : t('developers:webhooks.log.replayCaption', { time })}
          </Typography>
        </ButtonBase>
      </TableCell>
      <TableCell>
        <OutcomeLabel delivery={delivery} />
      </TableCell>
      <TableCell sx={{ ...mono, textAlign: 'end' }}>
        <bdi dir="ltr">
          {t('developers:webhooks.log.attempt', {
            attempt: delivery.attempts,
            max: WEBHOOK_DELIVERY_ATTEMPTS,
          })}
        </bdi>
      </TableCell>
      <TableCell sx={{ ...mono, textAlign: 'end', color: 'text.secondary', whiteSpace: 'nowrap' }}>
        <bdi dir="ltr">
          {delivery.durationMs === null ? '—' : durationText(delivery.durationMs, locale)}
        </bdi>
      </TableCell>
      <TableCell sx={{ fontSize: 12, color: 'text.secondary' }}>
        <ProgressText delivery={delivery} />
      </TableCell>
    </TableRow>
  );
}

const OUTCOME_ICON: Record<DeliveryOutcome, typeof Check> = {
  delivered: Check,
  http: CircleAlert,
  timeout: CircleAlert,
  refused: CircleAlert,
  redirect: CircleAlert,
  noAnswer: CircleAlert,
  queued: Clock,
  skipped: MinusCircle,
};

/** The status cell: an icon and the HTTP status, or the word for what happened instead. */
export function OutcomeLabel({ delivery }: { readonly delivery: WebhookDelivery }): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const outcome = deliveryOutcome(delivery);
  const Icon = OUTCOME_ICON[outcome];
  const color =
    outcome === 'delivered'
      ? tokens['status.success.text']
      : outcome === 'queued' || outcome === 'skipped'
        ? tokens['text.secondary']
        : tokens['status.danger.text'];
  const showCode = outcome === 'delivered' || outcome === 'http';

  return (
    <Box
      component="span"
      sx={{ display: 'inline-flex', alignItems: 'center', gap: 1, color, whiteSpace: 'nowrap' }}
    >
      <Icon size={14} aria-hidden="true" />
      <Box
        component="span"
        sx={
          showCode
            ? { fontFamily: 'var(--hd-font-mono, monospace)', fontSize: 13 }
            : { fontSize: 13 }
        }
      >
        {showCode ? delivery.responseStatus : t(`developers:webhooks.outcome.${outcome}`)}
      </Box>
    </Box>
  );
}

/** "Delivered", "Next retry 14:31 · in 23 minutes", "Gave up after 8". */
export function ProgressText({ delivery }: { readonly delivery: WebhookDelivery }): ReactNode {
  const t = useT();
  const { locale } = usePreferences();
  const next = nextRetryAt(delivery);

  if (delivery.status === 'succeeded') {
    return t(
      delivery.attempts > 1
        ? 'developers:webhooks.progress.deliveredOnRetry'
        : 'developers:webhooks.progress.delivered',
    );
  }
  if (delivery.status === 'failed') {
    return t('developers:webhooks.progress.gaveUp', { max: WEBHOOK_DELIVERY_ATTEMPTS });
  }
  if (delivery.status === 'skipped') {
    return t('developers:webhooks.progress.skipped');
  }
  if (next === null) {
    return t('developers:webhooks.progress.queued');
  }
  if (Date.parse(next) <= Date.now()) {
    return t('developers:webhooks.progress.due');
  }
  const time = clockTime(next, locale);
  return deliveryOutcome(delivery) === 'redirect'
    ? t('developers:webhooks.progress.redirectNext', { time })
    : t('developers:webhooks.progress.next', {
        time,
        when: relativeTime(next, Date.now(), locale),
      });
}

/** "When a delivery fails": the schedule the job really runs, numbered 1 to 8. */
export function RetrySchedule(): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const headingId = useId();
  const attempts = Array.from({ length: WEBHOOK_DELIVERY_ATTEMPTS }, (_, index) => index + 1);
  const wait = (attempt: number): string => {
    if (attempt === 1) {
      return t('developers:webhooks.schedule.now');
    }
    const seconds = retryDelayMs(attempt) / 1000;
    return seconds < 60
      ? t('developers:webhooks.schedule.seconds', { value: seconds })
      : t('developers:webhooks.schedule.minutes', { value: seconds / 60 });
  };

  return (
    <Card labelledBy={headingId}>
      <Box sx={{ padding: 4, display: 'flex', flexDirection: 'column', gap: 3 }}>
        <Typography id={headingId} variant="h3" component="h2" sx={{ fontSize: 14 }}>
          {t('developers:webhooks.schedule.heading')}
        </Typography>
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          {t('developers:webhooks.schedule.body', {
            timeout: WEBHOOK_TIMEOUT_MS / 1000,
            max: WEBHOOK_DELIVERY_ATTEMPTS,
          })}
        </Typography>
        <Box
          component="ol"
          aria-label={t('developers:webhooks.schedule.label')}
          sx={{
            margin: 0,
            padding: 0,
            listStyle: 'none',
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(56px, 1fr))',
            gap: 1,
          }}
        >
          {attempts.map((attempt) => (
            <Box
              component="li"
              key={attempt}
              sx={{
                paddingBlock: 1,
                paddingInline: 2,
                borderRadius: '6px',
                border: `1px solid ${tokens['border.default']}`,
                backgroundColor: tokens['bg.canvas'],
                textAlign: 'center',
                fontSize: 12,
                lineHeight: '16px',
              }}
            >
              <Box
                component="span"
                sx={{ display: 'block', fontFamily: 'var(--hd-font-mono, monospace)' }}
              >
                {attempt}
              </Box>
              <Box component="span" sx={{ display: 'block', color: 'text.secondary' }}>
                {wait(attempt)}
              </Box>
            </Box>
          ))}
        </Box>
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          {t('developers:webhooks.schedule.after')}
        </Typography>
      </Box>
    </Card>
  );
}
