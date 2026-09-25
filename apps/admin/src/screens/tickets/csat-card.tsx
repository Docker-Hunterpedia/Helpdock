import type { TicketCsat } from '@helpdock/schemas';
import { Box, Button, Typography } from '@mui/material';
import { Copy } from 'lucide-react';
import type { ReactNode } from 'react';
import { useT } from '../../app/i18n.js';
import { useSemanticTokens } from '../../app/tokens.js';

/**
 * Where the ticket's satisfaction survey stands (M1-12): pending, sent, rated
 * with its score and comment, or expired.
 *
 * Channels do not deliver the link yet (M8-06), so while it is usable the card
 * offers it to copy — `AdminTicketingFeedback`'s delivery note: "until then the
 * link is shown on the ticket for the agent to share". No artboard draws this
 * card; it follows the SLA card beside it (DESIGN §6.3), and is flagged in the
 * milestone doc for the canvas.
 */
export function CsatCard({
  csat,
  onCopy,
}: {
  readonly csat: TicketCsat;
  onCopy(link: string): void;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const { link } = csat;

  return (
    <Box
      component="section"
      sx={{
        padding: 4,
        borderRadius: '8px',
        backgroundColor: tokens['bg.canvas'],
        border: `1px solid ${tokens['border.default']}`,
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
      }}
    >
      <Typography variant="caption" component="h2" sx={{ color: 'text.secondary' }}>
        {t('tickets:csat.heading')}
      </Typography>

      <Typography variant="body2" component="p">
        {csat.state === 'rated'
          ? t('tickets:csat.rated', { rating: csat.rating ?? 0 })
          : t(`tickets:csat.${csat.state}`)}
      </Typography>

      {csat.comment === null ? null : (
        <Typography
          variant="body2"
          component="blockquote"
          sx={{
            margin: 0,
            paddingInlineStart: 3,
            borderInlineStart: `2px solid ${tokens['border.strong']}`,
            color: 'text.secondary',
          }}
        >
          {csat.comment}
        </Typography>
      )}

      {link === null ? null : (
        <>
          <Typography variant="caption" component="p" sx={{ color: 'text.secondary' }}>
            {t('tickets:csat.shareHint')}
          </Typography>
          <Button
            variant="outlined"
            size="small"
            startIcon={<Copy size={14} aria-hidden="true" />}
            onClick={() => {
              onCopy(link);
            }}
            sx={{ alignSelf: 'flex-start' }}
          >
            {t('tickets:csat.copyLink')}
          </Button>
        </>
      )}
    </Box>
  );
}
