import type { TelegramTicketContext } from '@helpdock/schemas';
import { Box, IconButton, Typography } from '@mui/material';
import { Copy, Send } from 'lucide-react';
import { type ReactNode, useId } from 'react';
import { useT } from '../../../app/i18n.js';
import { useSemanticTokens } from '../../../app/tokens.js';
import { useToast } from '../../../ui/toasts.tsx';

/**
 * DESIGN §6.3 ChannelIdentityCard (M6-02, `Admin/Ticket-Telegram`): who the
 * chat is with, under the contact in the details panel — the chat id (the
 * verified identity) with Copy, the username, the name, the language and how
 * it was chosen, and the bot. The footer says which of them can change.
 */
export function ChannelIdentityCard({
  context,
}: {
  readonly context: TelegramTicketContext;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const toast = useToast();
  const headingId = useId();
  const none = t('tickets:telegram.identity.none');

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(context.chatId);
      toast({ tone: 'success', message: t('tickets:telegram.identity.copied') });
    } catch {
      toast({ tone: 'danger', message: t('tickets:telegram.retryFailed') });
    }
  };

  const language =
    context.locale === null
      ? t('tickets:telegram.identity.notChosen')
      : context.languageChosenAt === null
        ? t(`tickets:telegram.languages.${context.locale}`)
        : t('tickets:telegram.identity.chosen', {
            language: t(`tickets:telegram.languages.${context.locale}`),
          });

  return (
    <Box
      component="section"
      aria-labelledby={headingId}
      sx={{
        padding: 3,
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
        borderRadius: '6px',
        border: `1px solid ${tokens['border.default']}`,
        backgroundColor: tokens['bg.canvas'],
      }}
    >
      <Typography
        id={headingId}
        component="h2"
        sx={{
          fontSize: 12,
          fontWeight: 500,
          color: 'text.secondary',
          display: 'flex',
          alignItems: 'center',
          gap: 1,
        }}
      >
        <Send size={14} aria-hidden="true" />
        {t('tickets:telegram.identity.heading')}
      </Typography>
      <Box
        component="dl"
        sx={{
          margin: 0,
          display: 'grid',
          gridTemplateColumns: 'max-content minmax(0, 1fr)',
          columnGap: 4,
          alignItems: 'center',
          '& dt': { fontSize: 12, fontWeight: 500, color: 'text.secondary' },
          '& dd': { margin: 0, fontSize: 13, minHeight: 28, display: 'flex', alignItems: 'center' },
        }}
      >
        <dt>{t('tickets:telegram.identity.chatId')}</dt>
        <dd>
          <Typography variant="mono" component="bdi" sx={{ fontSize: 13 }}>
            {context.chatId}
          </Typography>
          <IconButton
            size="small"
            aria-label={t('tickets:telegram.identity.copy')}
            onClick={() => {
              void copy();
            }}
            sx={{ width: 28, height: 28 }}
          >
            <Copy size={14} aria-hidden="true" />
          </IconButton>
        </dd>
        <dt>{t('tickets:telegram.identity.username')}</dt>
        <dd>{context.username === null ? none : <bdi>@{context.username}</bdi>}</dd>
        <dt>{t('tickets:telegram.identity.name')}</dt>
        <dd>{context.name === null ? none : <bdi>{context.name}</bdi>}</dd>
        <dt>{t('tickets:telegram.identity.language')}</dt>
        <dd>{language}</dd>
        <dt>{t('tickets:telegram.identity.bot')}</dt>
        <dd style={{ fontSize: 12 }}>
          <bdi>@{context.bot.username}</bdi>
        </dd>
      </Box>
      <Typography variant="caption" sx={{ color: 'text.secondary' }}>
        {t('tickets:telegram.identity.footer')}
      </Typography>
    </Box>
  );
}
