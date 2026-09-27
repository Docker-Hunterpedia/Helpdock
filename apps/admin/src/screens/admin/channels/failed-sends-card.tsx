import { EMAIL_SEND_ATTEMPTS, type FailedSend } from '@helpdock/schemas';
import {
  Box,
  Button,
  Link as MuiLink,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleCheck, RotateCw } from 'lucide-react';
import { type ReactNode, useId } from 'react';
import { Link } from 'react-router';
import { useT } from '../../../app/i18n.js';
import { usePreferences } from '../../../app/providers.tsx';
import { ticketRoute } from '../../../app/route-paths.js';
import { useSemanticTokens } from '../../../app/tokens.js';
import { useEmailApi } from '../../../auth/session.tsx';
import { emailKeys } from '../../../email/api.js';
import { visuallyHidden } from '../../../ui/visually-hidden.js';
import { messageTime } from '../../tickets/format.js';
import { SectionCard, useEmailAction } from './section-card.tsx';

/**
 * "Failed sends" of `Admin/Channels · Outgoing email`: the `email.send`
 * dead-letter queue as an Admin sees it (M2-08, the M2 exit criterion "sending
 * fails gracefully into the DLQ, visible in admin").
 *
 * Retry puts a send back in the queue with the same `Message-ID`; Discard
 * gives up on it and leaves the reply on its ticket marked "Not delivered".
 * Nothing here retries by itself.
 */
export function FailedSendsCard({ brandId }: { readonly brandId: string }): ReactNode {
  const t = useT();
  const api = useEmailApi();
  const tokens = useSemanticTokens();
  const queryClient = useQueryClient();
  const { locale } = usePreferences();
  const id = useId();
  const key = emailKeys.failedSends(brandId);

  const failed = useQuery({ queryKey: key, queryFn: () => api.failedSends(brandId) });
  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: key });
  };

  const retry = useEmailAction(
    (deliveryId: string) => api.retryFailedSend(brandId, deliveryId),
    t('channels:failed.retried'),
    refresh,
  );
  const discard = useEmailAction(
    (deliveryId: string) => api.discardFailedSend(brandId, deliveryId),
    t('channels:failed.discarded'),
    refresh,
  );
  const retryAll = useEmailAction(
    () => api.retryAllFailedSends(brandId),
    t('channels:failed.retriedAll'),
    refresh,
  );

  const rows = failed.data?.items ?? [];
  const busy = retry.isPending || discard.isPending || retryAll.isPending;

  return (
    <SectionCard
      id={`${id}-failed`}
      heading={t('channels:failed.heading')}
      caption={t('channels:failed.caption', { attempts: EMAIL_SEND_ATTEMPTS })}
      aside={
        rows.length === 0 ? null : (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            <Typography
              variant="mono"
              component="span"
              sx={{
                fontSize: 12,
                paddingInline: 2,
                borderRadius: '6px',
                backgroundColor: tokens['status.danger.tint'],
                color: tokens['status.danger.text'],
              }}
            >
              {rows.length}
            </Typography>
            <Button
              variant="outlined"
              size="small"
              disabled={busy}
              startIcon={<RotateCw size={14} aria-hidden="true" />}
              onClick={() => {
                retryAll.mutate(undefined);
              }}
            >
              {t('channels:failed.retryAll')}
            </Button>
          </Box>
        )
      }
    >
      {failed.isPending ? (
        <Box aria-busy="true" sx={{ minHeight: 44 }} />
      ) : rows.length === 0 ? (
        <Typography
          variant="body2"
          role="status"
          sx={{ color: 'text.secondary', display: 'flex', alignItems: 'center', gap: 2 }}
        >
          <CircleCheck size={16} aria-hidden="true" />
          {t('channels:failed.empty')}
        </Typography>
      ) : (
        <TableContainer
          sx={{ border: `1px solid ${tokens['border.default']}`, borderRadius: '6px' }}
        >
          <Table size="small" aria-labelledby={`${id}-failed-heading`}>
            <TableHead>
              <TableRow sx={{ backgroundColor: tokens['bg.muted'] }}>
                <TableCell>{t('channels:failed.recipient')}</TableCell>
                <TableCell>{t('channels:failed.ticket')}</TableCell>
                <TableCell>{t('channels:failed.lastError')}</TableCell>
                <TableCell align="right">{t('channels:failed.attempts')}</TableCell>
                <TableCell>{t('channels:failed.failedAt')}</TableCell>
                <TableCell>
                  <Box component="span" sx={visuallyHidden}>
                    {t('channels:failed.actions')}
                  </Box>
                </TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((row: FailedSend) => {
                const names = { recipient: row.recipient, ticket: row.ticketReference };
                return (
                  <TableRow key={row.id} sx={{ height: 44 }}>
                    <TableCell>
                      <bdi>{row.recipient}</bdi>
                    </TableCell>
                    <TableCell>
                      <MuiLink component={Link} to={ticketRoute(row.ticketId)}>
                        <Typography variant="mono" component="bdi" sx={{ fontSize: 13 }}>
                          {row.ticketReference}
                        </Typography>
                      </MuiLink>
                    </TableCell>
                    <TableCell
                      title={row.lastError ?? undefined}
                      sx={{
                        maxWidth: 320,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      <Typography variant="mono" component="bdi" sx={{ fontSize: 12 }}>
                        {row.lastError ?? '—'}
                      </Typography>
                    </TableCell>
                    <TableCell align="right">
                      <Typography variant="mono" component="span" sx={{ fontSize: 13 }}>
                        {t('channels:failed.attemptsValue', {
                          attempts: row.attempts,
                          max: row.maxAttempts,
                        })}
                      </Typography>
                    </TableCell>
                    <TableCell sx={{ color: 'text.secondary', whiteSpace: 'nowrap' }}>
                      {messageTime(row.failedAt, locale, Date.now())}
                    </TableCell>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>
                      <Button
                        size="small"
                        variant="text"
                        disabled={busy}
                        startIcon={<RotateCw size={14} aria-hidden="true" />}
                        aria-label={t('channels:failed.retryLabel', names)}
                        onClick={() => {
                          retry.mutate(row.id);
                        }}
                      >
                        {t('channels:failed.retry')}
                      </Button>
                      <Button
                        size="small"
                        variant="text"
                        disabled={busy}
                        aria-label={t('channels:failed.discardLabel', names)}
                        onClick={() => {
                          discard.mutate(row.id);
                        }}
                      >
                        {t('channels:failed.discard')}
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      )}
      <Typography variant="caption" sx={{ color: 'text.secondary' }}>
        {t('channels:failed.note')}
      </Typography>
    </SectionCard>
  );
}
