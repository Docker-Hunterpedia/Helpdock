import type { BlockedSender, BlockedSenderCreateRequest } from '@helpdock/schemas';
import {
  Box,
  Button,
  Checkbox,
  FormControlLabel,
  IconButton,
  InputAdornment,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Search, ShieldBan, Trash2 } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { useT } from '../../../app/i18n.js';
import { usePreferences } from '../../../app/providers.tsx';
import { useSemanticTokens } from '../../../app/tokens.js';
import { currentBrand, useSession, useTicketingApi } from '../../../auth/session.tsx';
import { EmptyState } from '../../../shell/empty-state.tsx';
import { isTicketingError } from '../../../ticketing/api.js';
import { refusalCopy } from '../../../ticketing/refusal-copy.js';
import { ConfirmDialog } from '../../../ui/confirm-dialog.tsx';
import { BlockSenderForm } from './block-sender-form.tsx';
import { addedOn, matchesSender } from './spam-format.js';
import { useTicketingAction, useTicketingReport } from './use-ticketing-action.js';

/**
 * The Spam tab of `Admin/Ticketing` (M1-11), built from the
 * `Admin/Ticketing › Spam` artboard: the block list with its dropped counter,
 * the "Spam status" card with the brand's one setting, and the "Block a
 * sender" card in the end column.
 *
 * **A refusal of what was typed stays in the card.** The three the api has
 * for a new block — not a valid sender, the brand's own domain, already
 * blocked — are drawn under the field, where the person fixes it; anything
 * else is a toast, as on every other tab.
 */
export function SpamTab(): ReactNode {
  const t = useT();
  const api = useTicketingApi();
  const session = useSession();
  const tokens = useSemanticTokens();
  const { locale } = usePreferences();
  const queryClient = useQueryClient();
  const report = useTicketingReport();
  const searchId = useId();
  const headingId = useId();

  const brand = currentBrand(session);
  const [adding, setAdding] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [term, setTerm] = useState('');
  const [unblocking, setUnblocking] = useState<BlockedSender | null>(null);

  const senders = useQuery({
    queryKey: ['blocked-senders', brand.id],
    queryFn: () => api.blockedSenders(brand.id),
  });
  const brandRow = useQuery({ queryKey: ['brand', brand.id], queryFn: () => api.brand(brand.id) });

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['blocked-senders', brand.id] });
  };

  const block = useTicketingAction(
    (request: BlockedSenderCreateRequest) => api.blockSender(brand.id, request),
    (request) => t('ticketing:toast.senderBlocked', { value: request.value }),
    refresh,
    (error: unknown) => {
      if (isTicketingError(error)) {
        setFormError(t(refusalCopy(error.reason)));
        return;
      }
      report(error);
    },
  );

  const unblock = useTicketingAction(
    (row: BlockedSender) => api.unblockSender(brand.id, row.id),
    (row) => t('ticketing:toast.senderUnblocked', { value: row.value }),
    refresh,
    report,
  );

  const saveSettings = useTicketingAction(
    (offerBlockSender: boolean) => api.updateSpamSettings(brand.id, { offerBlockSender }),
    () => t('ticketing:toast.spamSettingsSaved'),
    async () => {
      await queryClient.invalidateQueries({ queryKey: ['brand', brand.id] });
    },
    report,
  );

  const rows = senders.data?.senders ?? [];
  const shown = rows.filter((row) => matchesSender(row, term));
  const offer = saveSettings.isPending
    ? saveSettings.variables
    : (brandRow.data?.settings.offerBlockSender ?? true);

  return (
    <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 8, flexWrap: 'wrap' }}>
      <Box
        component="section"
        aria-labelledby={headingId}
        sx={{
          flex: '1 1 520px',
          maxWidth: 820,
          minWidth: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 3, flexWrap: 'wrap' }}>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
            <Typography id={headingId} variant="h3" component="h2" sx={{ fontSize: 16 }}>
              {t('ticketing:spam.blockList.heading')}
            </Typography>
            <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: 13 }}>
              {t('ticketing:spam.blockList.caption')}
            </Typography>
          </Box>
          <Button
            variant="contained"
            sx={{ marginInlineStart: 'auto' }}
            onClick={() => {
              setFormError(null);
              setAdding(true);
            }}
          >
            {t('ticketing:spam.blockList.add')}
          </Button>
        </Box>

        <Box
          sx={{
            borderRadius: '10px',
            border: `1px solid ${tokens['border.default']}`,
            backgroundColor: tokens['bg.surface'],
            overflow: 'hidden',
          }}
        >
          <Box
            sx={{
              paddingBlock: 3,
              paddingInline: 4,
              borderBlockEnd: `1px solid ${tokens['border.default']}`,
            }}
          >
            <TextField
              id={searchId}
              type="search"
              size="small"
              value={term}
              placeholder={t('ticketing:spam.blockList.searchPlaceholder')}
              onChange={(event) => {
                setTerm(event.target.value);
              }}
              sx={{ maxWidth: 320, width: '100%' }}
              slotProps={{
                htmlInput: { 'aria-label': t('ticketing:spam.blockList.search') },
                input: {
                  startAdornment: (
                    <InputAdornment position="start">
                      <Search size={14} aria-hidden="true" />
                    </InputAdornment>
                  ),
                },
              }}
            />
          </Box>

          {shown.length === 0 && !senders.isPending ? (
            <Box sx={{ padding: 6 }}>
              <EmptyState
                icon={ShieldBan}
                heading={t(
                  rows.length === 0
                    ? 'ticketing:spam.blockList.empty.heading'
                    : 'ticketing:spam.blockList.noMatch.heading',
                )}
                body={t(
                  rows.length === 0
                    ? 'ticketing:spam.blockList.empty.body'
                    : 'ticketing:spam.blockList.noMatch.body',
                )}
              />
            </Box>
          ) : (
            <TableContainer>
              <Table
                aria-label={t('ticketing:spam.blockList.table.caption', { brand: brand.name })}
              >
                <TableHead>
                  <TableRow sx={{ backgroundColor: tokens['bg.muted'] }}>
                    <TableCell>{t('ticketing:spam.blockList.table.sender')}</TableCell>
                    <TableCell>{t('ticketing:spam.blockList.table.kind')}</TableCell>
                    <TableCell>{t('ticketing:spam.blockList.table.addedBy')}</TableCell>
                    <TableCell>{t('ticketing:spam.blockList.table.added')}</TableCell>
                    <TableCell align="right">
                      {t('ticketing:spam.blockList.table.dropped')}
                    </TableCell>
                    <TableCell />
                  </TableRow>
                </TableHead>
                <TableBody>
                  {shown.map((row) => (
                    <TableRow key={row.id} sx={{ height: 48 }}>
                      <TableCell>
                        <Typography variant="mono" component="bdi" sx={{ fontSize: 13 }}>
                          {row.value}
                        </Typography>
                      </TableCell>
                      <TableCell>{t(`ticketing:spam.kinds.${row.kind}`)}</TableCell>
                      <TableCell>
                        {row.createdByName ?? t('ticketing:spam.blockList.table.formerStaff')}
                      </TableCell>
                      <TableCell sx={{ color: 'text.secondary' }}>
                        {addedOn(row.createdAt, locale)}
                      </TableCell>
                      <TableCell align="right">
                        <Typography variant="mono" component="span" sx={{ fontSize: 13 }}>
                          {row.droppedCount}
                        </Typography>
                      </TableCell>
                      <TableCell sx={{ width: 40 }}>
                        <IconButton
                          size="small"
                          aria-label={t('ticketing:spam.blockList.table.unblock', {
                            value: row.value,
                          })}
                          disabled={unblock.isPending}
                          onClick={() => {
                            setUnblocking(row);
                          }}
                        >
                          <Trash2 size={14} aria-hidden="true" />
                        </IconButton>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </Box>

        <Box
          sx={{
            display: 'flex',
            flexDirection: 'column',
            gap: 3,
            paddingBlock: 4,
            paddingInline: 5,
            borderRadius: '10px',
            border: `1px solid ${tokens['border.default']}`,
            backgroundColor: tokens['bg.surface'],
          }}
        >
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
            <Typography variant="h3" component="h3" sx={{ fontSize: 14 }}>
              {t('ticketing:spam.status.heading')}
            </Typography>
            <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: 13 }}>
              {t('ticketing:spam.status.body')}
            </Typography>
          </Box>
          <FormControlLabel
            sx={{ alignItems: 'flex-start', marginInline: 0, gap: 3 }}
            control={
              <Checkbox
                checked={offer}
                disabled={saveSettings.isPending || brandRow.isPending}
                sx={{ padding: 0, marginBlockStart: '2px' }}
                onChange={(event) => {
                  saveSettings.mutate(event.target.checked);
                }}
              />
            }
            label={
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                <Typography component="span" sx={{ fontWeight: 500 }}>
                  {t('ticketing:spam.status.offer')}
                </Typography>
                <Typography
                  variant="caption"
                  component="span"
                  sx={{ color: 'text.secondary', fontSize: 13 }}
                >
                  {t('ticketing:spam.status.offerHint')}
                </Typography>
              </Box>
            }
          />
        </Box>
      </Box>

      <Box sx={{ flex: '0 0 300px', maxWidth: 300 }}>
        {adding ? (
          <BlockSenderForm
            busy={block.isPending}
            error={formError}
            onSubmit={(request) => {
              setFormError(null);
              block.mutate(request, {
                onSuccess: () => {
                  setAdding(false);
                },
              });
            }}
            onCancel={() => {
              setAdding(false);
              setFormError(null);
            }}
          />
        ) : null}
      </Box>

      <ConfirmDialog
        open={unblocking !== null}
        destructive
        busy={unblock.isPending}
        title={t('ticketing:spam.confirm.unblock.title', { value: unblocking?.value ?? '' })}
        body={t('ticketing:spam.confirm.unblock.body')}
        confirmLabel={t('ticketing:spam.confirm.unblock.submit')}
        onClose={() => {
          setUnblocking(null);
        }}
        onConfirm={() => {
          if (unblocking !== null) {
            unblock.mutate(unblocking);
          }
          setUnblocking(null);
        }}
      />
    </Box>
  );
}
