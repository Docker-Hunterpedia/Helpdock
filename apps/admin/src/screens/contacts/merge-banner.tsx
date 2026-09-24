import type { ContactMergeSummary } from '@helpdock/schemas';
import { Box, Button, Typography } from '@mui/material';
import { GitMerge, Undo2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { useT } from '../../app/i18n.js';
import { usePreferences } from '../../app/providers.tsx';
import { useSemanticTokens } from '../../app/tokens.js';
import { messageTime } from '../tickets/format.js';

/**
 * "After a merge", panel 4 of `Admin/Contact dialogs` (M1-13): one DESIGN §6.4
 * Banner per merge into this contact that can still be undone. It stays on the
 * surviving contact for the 24 hours of DOMAIN-RULES §4.4 — the api stops
 * listing a merge once they are up — and its Undo restores both contacts and
 * moves the tickets back.
 */
export function MergeBanners({
  merges,
  busy,
  now,
  onUndo,
}: {
  readonly merges: readonly ContactMergeSummary[];
  readonly busy: boolean;
  readonly now: number;
  onUndo(merge: ContactMergeSummary): void;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const { locale } = usePreferences();

  return merges.map((merge) => {
    const time = messageTime(merge.createdAt, locale, now);

    return (
      <Box
        key={merge.id}
        role="status"
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 3,
          paddingBlock: '10px',
          paddingInline: '14px',
          marginBlockEnd: 4,
          borderRadius: '8px',
          border: `1px solid ${tokens['status.info']}`,
          backgroundColor: tokens['status.info.tint'],
          color: tokens['status.info.text'],
        }}
      >
        <GitMerge size={16} aria-hidden="true" style={{ flexShrink: 0 }} />
        <Typography variant="body2" sx={{ color: 'inherit', flexGrow: 1 }}>
          {merge.actorName === null
            ? t('contacts:merge.bannerNoActor', { merged: merge.mergedContact.name, time })
            : t('contacts:merge.banner', {
                merged: merge.mergedContact.name,
                actor: merge.actorName,
                time,
              })}
        </Typography>
        <Button
          size="small"
          variant="outlined"
          disabled={busy}
          startIcon={<Undo2 size={14} aria-hidden="true" />}
          onClick={() => {
            onUndo(merge);
          }}
          sx={{ flexShrink: 0, backgroundColor: tokens['bg.surface'] }}
        >
          {t('contacts:merge.bannerUndo', { time: messageTime(merge.undoUntil, locale, now) })}
        </Button>
      </Box>
    );
  });
}
