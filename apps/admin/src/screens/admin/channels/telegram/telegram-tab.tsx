import type { TelegramBot } from '@helpdock/schemas';
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
import { useQuery } from '@tanstack/react-query';
import { Check, CircleAlert, Pencil, Plus, Send, Trash2 } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useT } from '../../../../app/i18n.js';
import { usePreferences } from '../../../../app/providers.tsx';
import { telegramBotRoute } from '../../../../app/route-paths.js';
import { useSemanticTokens } from '../../../../app/tokens.js';
import { currentBrand, useSession } from '../../../../auth/session.tsx';
import { EmptyState } from '../../../../shell/empty-state.tsx';
import { telegramKeys } from '../../../../telegram/api.js';
import { useTelegramApi } from '../../../../telegram/context.tsx';
import { ActionsMenu } from '../../../../ui/actions-menu.tsx';
import { AlertBanner } from '../../../../ui/alert-banner.tsx';
import { visuallyHidden } from '../../../../ui/visually-hidden.js';
import { ago, clockTime } from '../format.js';
import { NoteCard } from '../note-card.tsx';
import { AddBotDialog } from './add-bot-dialog.tsx';
import { BotHealth, BotHealthLegend } from './bot-health.tsx';
import { DeleteBotDialog } from './delete-bot-dialog.tsx';

/**
 * Channels › Telegram (M6-05), panel 1 and 3 of `Admin/Channels-Telegram`:
 * the bots with where they route, their webhook, their last update and their
 * health; "How updates arrive" and the legend under them; and the Add bot and
 * Delete dialogs over the list. With no bots, the empty state replaces the
 * table. "Add bot" sits in the page header, which owns `adding`.
 */
export function TelegramTab({
  adding,
  onAddingChange,
}: {
  readonly adding: boolean;
  onAddingChange(open: boolean): void;
}): ReactNode {
  const t = useT();
  const api = useTelegramApi();
  const brand = currentBrand(useSession());
  const tokens = useSemanticTokens();
  const navigate = useNavigate();
  const headingId = useId();
  const [deleting, setDeleting] = useState<TelegramBot | null>(null);

  const bots = useQuery({
    queryKey: telegramKeys.bots(brand.id),
    queryFn: () => api.bots(brand.id),
  });

  if (bots.isError) {
    return <AlertBanner tone="danger">{t('channels:loadFailed')}</AlertBanner>;
  }

  const rows = bots.data?.bots ?? [];

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <Box
        component="section"
        aria-labelledby={headingId}
        aria-busy={bots.isPending}
        sx={{
          borderRadius: '10px',
          border: `1px solid ${tokens['border.default']}`,
          backgroundColor: tokens['bg.surface'],
          overflow: 'hidden',
        }}
      >
        <Box
          sx={{
            paddingBlock: '14px',
            paddingInline: 4,
            display: 'flex',
            alignItems: 'baseline',
            gap: 2,
            flexWrap: 'wrap',
          }}
        >
          <Typography id={headingId} variant="h3" component="h2" sx={{ fontSize: 16 }}>
            {t('channels:telegram.heading')}
          </Typography>
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            {t('channels:telegram.caption', { count: rows.length })}
          </Typography>
        </Box>

        {rows.length === 0 && !bots.isPending ? (
          <Box sx={{ padding: 6 }}>
            <EmptyState
              icon={Send}
              heading={t('channels:telegram.empty.heading')}
              body={t('channels:telegram.empty.body')}
              action={
                <Button
                  variant="contained"
                  aria-haspopup="dialog"
                  startIcon={<Plus size={16} aria-hidden="true" />}
                  onClick={() => {
                    onAddingChange(true);
                  }}
                >
                  {t('channels:addBot')}
                </Button>
              }
            />
          </Box>
        ) : (
          <TableContainer>
            <Table aria-labelledby={headingId} sx={{ tableLayout: 'fixed' }}>
              <TableHead>
                <TableRow sx={{ backgroundColor: tokens['bg.muted'] }}>
                  <TableCell>{t('channels:telegram.columns.bot')}</TableCell>
                  <TableCell sx={{ width: 140 }}>
                    {t('channels:telegram.columns.routesTo')}
                  </TableCell>
                  <TableCell>{t('channels:telegram.columns.webhook')}</TableCell>
                  <TableCell sx={{ width: 170 }}>
                    {t('channels:telegram.columns.lastUpdate')}
                  </TableCell>
                  <TableCell sx={{ width: 170 }}>{t('channels:telegram.columns.health')}</TableCell>
                  <TableCell sx={{ width: 48 }}>
                    <Box component="span" sx={visuallyHidden}>
                      {t('channels:telegram.columns.actions')}
                    </Box>
                  </TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map((bot) => (
                  <TableRow key={bot.id}>
                    <TableCell>
                      <MuiLink
                        component={Link}
                        to={telegramBotRoute(bot.id)}
                        sx={{ color: 'text.primary', fontWeight: 500, display: 'block' }}
                      >
                        <bdi>@{bot.username}</bdi>
                      </MuiLink>
                      <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                        <bdi>{bot.displayName}</bdi>
                      </Typography>
                    </TableCell>
                    <TableCell>{bot.departmentName}</TableCell>
                    <TableCell>
                      <WebhookCell bot={bot} />
                    </TableCell>
                    <TableCell>
                      <LastUpdate bot={bot} />
                    </TableCell>
                    <TableCell>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                        <BotHealth bot={bot} />
                        {bot.health.state === 'failing' ? (
                          <MuiLink
                            component={Link}
                            to={telegramBotRoute(bot.id)}
                            aria-label={t('channels:telegram.health.fixFor', {
                              username: bot.username,
                            })}
                            sx={{ fontSize: 12, fontWeight: 500 }}
                          >
                            {t('channels:telegram.health.fix')}
                          </MuiLink>
                        ) : null}
                      </Box>
                    </TableCell>
                    <TableCell>
                      <ActionsMenu
                        label={t('channels:telegram.actionsFor', { username: bot.username })}
                        menuLabel={t('channels:telegram.actionsFor', { username: bot.username })}
                        items={[
                          {
                            id: 'open',
                            label: t('channels:telegram.open'),
                            icon: Pencil,
                            onSelect: () => {
                              void navigate(telegramBotRoute(bot.id));
                            },
                          },
                          {
                            id: 'delete',
                            label: t('channels:telegram.delete'),
                            icon: Trash2,
                            tone: 'danger',
                            dividerBefore: true,
                            onSelect: () => {
                              setDeleting(bot);
                            },
                          },
                        ]}
                      />
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
          display: 'grid',
          gridTemplateColumns: { xs: 'minmax(0, 1fr)', lg: 'minmax(0, 1fr) minmax(0, 1fr)' },
          gap: 6,
          alignItems: 'start',
        }}
      >
        <NoteCard heading={t('channels:telegram.updates.heading')}>
          {t('channels:telegram.updates.body')}
        </NoteCard>
        <NoteCard heading={t('channels:telegram.legend.heading')}>
          <BotHealthLegend />
        </NoteCard>
      </Box>

      <AddBotDialog
        open={adding}
        onClose={() => {
          onAddingChange(false);
        }}
      />
      <DeleteBotDialog
        bot={deleting}
        onClose={() => {
          setDeleting(null);
        }}
      />
    </Box>
  );
}

/** "Set · with secret token", "Not set", "Polling", or Telegram's last refusal. */
function WebhookCell({ bot }: { readonly bot: TelegramBot }): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const { locale } = usePreferences();

  if (bot.mode === 'polling') {
    return <Typography sx={{ fontSize: 13 }}>{t('channels:telegram.webhook.polling')}</Typography>;
  }
  if (bot.health.state === 'failing' && bot.health.lastError !== null) {
    return (
      <Box sx={{ color: tokens['status.danger.text'], fontSize: 12, minWidth: 0 }}>
        <Box
          component="span"
          sx={{ display: 'inline-flex', alignItems: 'center', gap: 1, fontWeight: 500 }}
        >
          <CircleAlert size={14} aria-hidden="true" />
          {t('channels:telegram.webhook.error')}
        </Box>
        <Typography
          component="p"
          variant="caption"
          sx={{ color: 'inherit', overflowWrap: 'anywhere' }}
        >
          {t('channels:telegram.webhook.telegramSaid', {
            error: bot.health.lastError,
            time: bot.health.lastErrorAt === null ? '' : clockTime(bot.health.lastErrorAt, locale),
          })}
        </Typography>
      </Box>
    );
  }
  if (bot.webhook.url === null) {
    return (
      <Typography sx={{ fontSize: 13, color: 'text.secondary' }}>
        {t('channels:telegram.webhook.notSet')}
      </Typography>
    );
  }

  return (
    <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 1, fontSize: 13 }}>
      <Check size={14} aria-hidden="true" color={tokens['status.success']} />
      {t('channels:telegram.webhook.set')}
      <Typography component="span" variant="caption" sx={{ color: 'text.secondary' }}>
        {' · '}
        {t('channels:telegram.webhook.withSecret')}
      </Typography>
    </Box>
  );
}

function LastUpdate({ bot }: { readonly bot: TelegramBot }): ReactNode {
  const t = useT();
  const { locale } = usePreferences();
  const [now] = useState(Date.now);
  const at = bot.health.lastUpdateAt;

  return (
    <Typography variant="mono" component="span" sx={{ fontSize: 12, color: 'text.secondary' }}>
      {at === null
        ? t('channels:telegram.noUpdate')
        : t('channels:telegram.lastUpdate', {
            time: clockTime(at, locale),
            ago: ago(at, now, locale),
          })}
    </Typography>
  );
}
