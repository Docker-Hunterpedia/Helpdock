import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Typography,
} from '@mui/material';
import type { ReactNode } from 'react';
import { useT } from '../../../app/i18n.js';
import { useSemanticTokens } from '../../../app/tokens.js';
import {
  type BulkChoice,
  dialogKindOf,
  type PreviewSummary,
  reasonKey,
} from '../../../tickets/bulk.js';

/**
 * The preview before an apply (`Admin/Tickets-Bulk`, M14-04): "Close 12
 * tickets?", how many will change and how many cannot, each ticket that cannot
 * with its reference and the reason in words, a note on what an Undo does not
 * recall, and *Close 10* / *Apply to 10*.
 *
 * It is shown only when something would not change. A preview where every
 * ticket changes is applied at once, so a plain bulk edit is one click, and
 * this dialog is the place the person learns why a few were left out. When
 * nothing at all would change the primary is left out: there is nothing to
 * apply, and the list says why.
 *
 * After a `bulk-changed` (409) the same dialog is shown again with the new
 * numbers and a sentence saying so; the apply is all or nothing against what
 * was previewed (owner decision D-22), so the person confirms the new list.
 */
export function BulkPreviewDialog({
  choice,
  summary,
  refreshed,
  applying,
  referenceOf,
  onConfirm,
  onCancel,
}: {
  /** Null while no preview is being reviewed; the dialog is closed. */
  readonly choice: BulkChoice | null;
  readonly summary: PreviewSummary | null;
  /** The list was previewed again because something changed meanwhile. */
  readonly refreshed: boolean;
  readonly applying: boolean;
  /** The reference ("HD-1029") of a ticket id. */
  referenceOf(ticketId: string): string;
  onConfirm(): void;
  onCancel(): void;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const open = choice !== null && summary !== null;
  const kind = choice === null ? 'change' : dialogKindOf(choice);
  const total = summary?.total ?? 0;
  const willChange = summary?.changing.length ?? 0;
  const blocked = summary?.blockers.length ?? 0;

  const title =
    kind === 'close'
      ? t('tickets:bulk.dialog.titleClose', { count: total })
      : t('tickets:bulk.dialog.titleChange', { count: total });
  const lead =
    willChange === 0
      ? kind === 'close'
        ? t('tickets:bulk.dialog.noneClose', { count: total })
        : t('tickets:bulk.dialog.noneChange', { count: total })
      : kind === 'close'
        ? t('tickets:bulk.dialog.summaryClose', { count: total, willChange })
        : t('tickets:bulk.dialog.summaryChange', { count: total, willChange });
  const blockedLine =
    kind === 'close'
      ? t('tickets:bulk.dialog.blockedClose', { count: blocked })
      : t('tickets:bulk.dialog.blockedChange', { count: blocked });

  return (
    <Dialog
      open={open}
      onClose={() => {
        if (!applying) {
          onCancel();
        }
      }}
      maxWidth="xs"
      fullWidth
      slotProps={{ paper: { sx: { maxWidth: 480, borderRadius: '10px' } } }}
    >
      <DialogTitle sx={{ fontSize: 16, fontWeight: 600 }}>{title}</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {refreshed ? (
          <Typography
            role="status"
            variant="caption"
            sx={{
              paddingBlock: 2,
              paddingInline: 3,
              borderRadius: '6px',
              backgroundColor: tokens['status.warning.tint'],
              color: tokens['status.warning.text'],
            }}
          >
            {t('tickets:bulk.dialog.refreshed')}
          </Typography>
        ) : null}

        <Typography variant="body2">
          {/* One sentence when nothing is left out of a partial list, two otherwise. */}
          {willChange === 0 ? lead : `${lead} ${blockedLine}`}
        </Typography>

        <Box
          component="ul"
          aria-label={t('tickets:bulk.dialog.ticketsList')}
          sx={{ listStyle: 'none', margin: 0, padding: 0 }}
        >
          {summary?.blockers.map((blocker) => (
            <Box
              component="li"
              key={blocker.ticketId}
              sx={{
                display: 'flex',
                gap: 3,
                paddingBlock: 2,
                borderBlockStart: `1px solid ${tokens['border.default']}`,
                fontSize: 13,
              }}
            >
              <Typography
                component="bdi"
                variant="mono"
                sx={{ fontSize: 'inherit', color: 'text.secondary', flexShrink: 0 }}
              >
                {referenceOf(blocker.ticketId)}
              </Typography>
              <span>
                {t(`tickets:${reasonKey(blocker.reason, choice ?? { kind: 'spam' })}` as never)}
              </span>
            </Box>
          ))}
        </Box>

        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          {kind === 'close'
            ? t('tickets:bulk.dialog.closeNote')
            : t('tickets:bulk.dialog.changeNote')}
        </Typography>
      </DialogContent>
      <DialogActions sx={{ padding: 4, gap: 2 }}>
        <Button variant="text" onClick={onCancel} disabled={applying}>
          {willChange === 0 ? t('tickets:bulk.dialog.dismiss') : t('tickets:bulk.dialog.cancel')}
        </Button>
        {willChange === 0 ? null : (
          <Button variant="contained" onClick={onConfirm} disabled={applying}>
            {applying
              ? t('tickets:bulk.dialog.applying')
              : kind === 'close'
                ? t('tickets:bulk.dialog.confirmClose', { n: willChange })
                : t('tickets:bulk.dialog.confirmChange', { n: willChange })}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
