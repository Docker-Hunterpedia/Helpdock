import type { QueueCounts, SystemQueues } from '@helpdock/schemas';
import {
  Box,
  Link,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { useT } from '../../../app/i18n.js';
import { useSemanticTokens } from '../../../app/tokens.js';
import { Card } from './card.js';
import { formatCount, formatDuration } from './format.js';
import {
  ALL_QUEUES_PAGE_SIZE,
  SYSTEM_QUEUES_QUERY_KEY,
  SYSTEM_REFETCH_MS,
  type SystemApi,
} from './system-api.js';

/**
 * The queue table of the artboard: mono numerals end-aligned (DESIGN §6.5), a
 * failed count in danger when there is one, and the dead-letter count at the
 * header's end.
 *
 * The status read carries only the first few queues, so that one request draws
 * the whole page. "All queues" therefore *fetches* the rest from
 * `GET /api/install/system/queues` rather than expanding what is already here:
 * expanding a list that holds five of eleven would move a label and nothing
 * else.
 */

const numeralCell = {
  textAlign: 'end',
  fontVariantNumeric: 'tabular-nums',
} as const;

function QueueRow({ queue }: { readonly queue: QueueCounts }): ReactNode {
  const tokens = useSemanticTokens();

  return (
    <TableRow>
      <TableCell>
        <Typography variant="body2" component="span">
          {queue.name}
        </Typography>
      </TableCell>
      <TableCell sx={numeralCell}>
        <Typography variant="mono" component="span">
          {formatCount(queue.waiting)}
        </Typography>
      </TableCell>
      <TableCell sx={numeralCell}>
        <Typography variant="mono" component="span">
          {formatCount(queue.active)}
        </Typography>
      </TableCell>
      <TableCell sx={numeralCell}>
        <Typography
          variant="mono"
          component="span"
          sx={{ color: queue.failed > 0 ? tokens['status.danger.text'] : 'inherit' }}
        >
          {formatCount(queue.failed)}
        </Typography>
      </TableCell>
      <TableCell sx={numeralCell}>
        <Typography variant="mono" component="span">
          {formatCount(queue.delayed)}
        </Typography>
      </TableCell>
      <TableCell sx={numeralCell}>
        <Typography variant="mono" component="span" sx={{ color: 'text.secondary' }}>
          {queue.oldestWaitingSeconds === null ? '—' : formatDuration(queue.oldestWaitingSeconds)}
        </Typography>
      </TableCell>
    </TableRow>
  );
}

export function QueuesCard({
  summary,
  api,
  showAll = false,
}: {
  /** The queues the status read carried, and how many there are in all. */
  readonly summary: SystemQueues;
  readonly api: SystemApi;
  /** The queue screen opens with every queue; the System page's card folds. */
  readonly showAll?: boolean;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const [expanded, setExpanded] = useState(showAll);

  const full = useQuery({
    queryKey: SYSTEM_QUEUES_QUERY_KEY,
    queryFn: () => api.queues({ page: 1, pageSize: ALL_QUEUES_PAGE_SIZE }),
    enabled: expanded,
    refetchInterval: SYSTEM_REFETCH_MS,
    retry: false,
  });

  // The summary stands in until the full list arrives, so expanding never
  // blanks the table it is expanding.
  const shown = expanded ? (full.data ?? summary) : summary;
  const foldable = !showAll && summary.total > summary.queues.length;

  return (
    <Card
      title={t('system:queues.title')}
      action={
        shown.deadLettered > 0 ? (
          <Typography variant="caption" sx={{ color: tokens['status.danger.text'] }}>
            {t('system:queues.deadLetter', { count: shown.deadLettered })}
          </Typography>
        ) : null
      }
    >
      {shown.queues.length === 0 ? (
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          {t('system:queues.empty')}
        </Typography>
      ) : (
        <>
          <Table size="small" aria-label={t('system:queues.title')}>
            <TableHead sx={{ backgroundColor: tokens['bg.muted'] }}>
              <TableRow>
                <TableCell>{t('system:queues.name')}</TableCell>
                <TableCell sx={numeralCell}>{t('system:queues.waiting')}</TableCell>
                <TableCell sx={numeralCell}>{t('system:queues.active')}</TableCell>
                <TableCell sx={numeralCell}>{t('system:queues.failed')}</TableCell>
                <TableCell sx={numeralCell}>{t('system:queues.delayed')}</TableCell>
                <TableCell sx={numeralCell}>{t('system:queues.oldest')}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {shown.queues.map((queue) => (
                <QueueRow key={queue.name} queue={queue} />
              ))}
            </TableBody>
          </Table>

          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 3,
              marginBlockStart: 3,
            }}
          >
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              {t('system:queues.footer', {
                shown: formatCount(shown.queues.length),
                total: formatCount(shown.total),
              })}
            </Typography>
            {foldable ? (
              <Link
                component="button"
                type="button"
                variant="caption"
                onClick={() => {
                  setExpanded((open) => !open);
                }}
              >
                {t(expanded ? 'system:queues.showFewer' : 'system:queues.showAll')}
              </Link>
            ) : null}
          </Box>
        </>
      )}
    </Card>
  );
}
