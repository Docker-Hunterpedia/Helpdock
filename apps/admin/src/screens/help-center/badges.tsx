import type { HcArticleStatus, HcLocale, HcVisibility } from '@helpdock/schemas';
import { Box } from '@mui/material';
import { Globe, Lock, Plus } from 'lucide-react';
import type { ReactNode } from 'react';
import { useT } from '../../app/i18n.js';
import { useSemanticTokens } from '../../app/tokens.js';
import { visuallyHidden } from '../../ui/visually-hidden.js';

/**
 * The three marks of an article row (DESIGN §6.2): its status as a
 * StatusBadge-shaped pill, its visibility as an icon and a word, and a
 * LanguageChip per locale — dashed when that translation does not exist, so
 * missing Arabic is visible at a glance and named for a screen reader.
 */

export function ArticleStatusBadge({
  status,
  scheduledLabel,
}: {
  readonly status: HcArticleStatus;
  /** "Scheduled · 1 Oct 09:00", when the status is `scheduled`. */
  readonly scheduledLabel?: string | undefined;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const tone = {
    published: {
      background: tokens['status.success.tint'],
      color: tokens['status.success.text'],
      dot: tokens['status.success'],
      border: 'transparent',
    },
    scheduled: {
      background: tokens['status.info.tint'],
      color: tokens['status.info.text'],
      dot: tokens['status.info'],
      border: 'transparent',
    },
    draft: {
      background: tokens['bg.muted'],
      color: tokens['text.secondary'],
      dot: tokens['text.secondary'],
      border: 'transparent',
    },
    archived: {
      background: tokens['bg.surface'],
      color: tokens['text.secondary'],
      dot: tokens['text.secondary'],
      border: tokens['border.strong'],
    },
  }[status];

  return (
    <Box
      component="span"
      sx={{
        height: 22,
        paddingInline: 2,
        borderRadius: '999px',
        border: `1px solid ${tone.border}`,
        backgroundColor: tone.background,
        color: tone.color,
        fontSize: 12,
        fontWeight: 500,
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        whiteSpace: 'nowrap',
      }}
    >
      <Box
        component="span"
        aria-hidden="true"
        sx={{ width: 6, height: 6, borderRadius: '999px', backgroundColor: tone.dot }}
      />
      {status === 'scheduled' && scheduledLabel !== undefined
        ? scheduledLabel
        : t(`helpCenter:status.${status}`)}
    </Box>
  );
}

export function VisibilityLabel({ visibility }: { readonly visibility: HcVisibility }): ReactNode {
  const t = useT();
  const Icon = visibility === 'public' ? Globe : Lock;
  return (
    <Box
      component="span"
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        color: visibility === 'public' ? 'text.secondary' : 'text.primary',
      }}
    >
      <Icon size={14} aria-hidden="true" />
      {t(`helpCenter:visibility.${visibility}`)}
    </Box>
  );
}

export function LanguageChip({
  locale,
  present,
}: {
  readonly locale: HcLocale;
  readonly present: boolean;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  return (
    <Box
      component="span"
      sx={{
        height: 20,
        paddingInline: '6px',
        borderRadius: '6px',
        border: `1px ${present ? 'solid' : 'dashed'} ${present ? tokens['border.default'] : tokens['border.strong']}`,
        backgroundColor: present ? tokens['bg.muted'] : 'transparent',
        color: present ? 'text.primary' : 'text.secondary',
        fontFamily: '"IBM Plex Mono", monospace',
        fontSize: 12,
        display: 'inline-flex',
        alignItems: 'center',
        gap: '2px',
      }}
    >
      <Box component="span" sx={visuallyHidden}>
        {t(
          present ? `helpCenter:languages.${locale}` : `helpCenter:languages.missing.${locale}`,
        )}{' '}
      </Box>
      {present ? null : <Plus size={10} aria-hidden="true" />}
      <span aria-hidden="true">{locale}</span>
    </Box>
  );
}
