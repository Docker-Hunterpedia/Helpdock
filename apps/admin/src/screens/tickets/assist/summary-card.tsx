import type { SummaryResult } from '@helpdock/schemas';
import { Box, Button, IconButton, Typography } from '@mui/material';
import { RefreshCw, Sparkles, X } from 'lucide-react';
import { type ReactNode, useId } from 'react';
import { useT } from '../../../app/i18n.js';
import { usePreferences } from '../../../app/providers.tsx';
import { useSemanticTokens } from '../../../app/tokens.js';
import { AssistLogDisclosure } from './ai-log-disclosure.tsx';

/**
 * The Summary variant of DESIGN §6.3 AISuggestionCard (M7-05): opens the
 * thread as a radius lg card with "from 5 messages · 10:02", a ghost Refresh,
 * a hide button, and the points as a list.
 */
export function SummaryCard({
  summary,
  busy,
  onRefresh,
  onHide,
}: {
  readonly summary: SummaryResult;
  readonly busy: boolean;
  onRefresh(): void;
  onHide(): void;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const { locale } = usePreferences();
  const headingId = useId();
  const time = new Intl.DateTimeFormat(locale === 'ar' ? 'ar-u-nu-latn' : 'en-GB', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(summary.generatedAt));

  return (
    <Box
      component="section"
      aria-labelledby={headingId}
      sx={{
        width: '100%',
        padding: '12px 16px',
        borderRadius: '10px',
        backgroundColor: tokens['action.primary.tint'],
        border: `1px solid ${tokens['border.default']}`,
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        <Sparkles size={14} aria-hidden="true" color={tokens['action.primary']} />
        <Typography id={headingId} component="h3" sx={{ fontSize: 13, fontWeight: 600 }}>
          {t('tickets:assist.summary.title')}
        </Typography>
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          {t('tickets:assist.summary.caption', { count: summary.messageCount, time })}
        </Typography>
        <Button
          size="small"
          variant="text"
          disabled={busy}
          startIcon={<RefreshCw size={14} aria-hidden="true" />}
          onClick={onRefresh}
          sx={{ marginInlineStart: 'auto' }}
        >
          {t('tickets:assist.summary.refresh')}
        </Button>
        <IconButton
          size="small"
          aria-label={t('tickets:assist.summary.hide')}
          onClick={onHide}
          sx={{ width: 28, height: 28 }}
        >
          <X size={16} aria-hidden="true" />
        </IconButton>
      </Box>
      <Box
        component="ul"
        sx={{ margin: 0, paddingInlineStart: 5, fontSize: 14, lineHeight: '20px' }}
      >
        {summary.points.map((point) => (
          <li key={point}>
            <bdi>{point}</bdi>
          </li>
        ))}
      </Box>
      <AssistLogDisclosure meta={summary.meta} />
    </Box>
  );
}
