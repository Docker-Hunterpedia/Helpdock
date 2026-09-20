import type { Attachment } from '@helpdock/schemas';
import { Box, CircularProgress, IconButton, Typography } from '@mui/material';
import { Paperclip, ShieldAlert, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { useT } from '../../app/i18n.js';
import { useSemanticTokens } from '../../app/tokens.js';

/**
 * One attachment, on a message or in the composer while it is still going up.
 *
 * Three states, because the pipeline has three answers (M1-10): it is working
 * on it, it is done, or it refused. A refusal is drawn rather than hidden — the
 * file is not coming, and a chip that quietly disappeared would leave somebody
 * believing they had sent it.
 *
 * No thumbnail. A URL to render is presigned, lives five minutes and has to be
 * asked for per attachment; a list of them is a burst of requests for pictures
 * nobody has looked at yet. The viewer is M1-10's to add where it belongs.
 */

const BYTES_PER_KB = 1024;

/** `82 KB`, `1.2 MB`. Latin digits in both locales (DESIGN §7). */
export const fileSize = (bytes: number): string => {
  if (bytes < BYTES_PER_KB) {
    return `${bytes} B`;
  }

  const kb = bytes / BYTES_PER_KB;
  if (kb < BYTES_PER_KB) {
    return `${Math.round(kb)} KB`;
  }

  return `${(kb / BYTES_PER_KB).toFixed(1)} MB`;
};

export function AttachmentChip({
  name,
  size,
  state,
  onRemove,
}: {
  readonly name: string;
  readonly size: number;
  readonly state: 'settling' | 'ready' | 'refused';
  /** Drawn only while a chip is still the composer's to take back. */
  onRemove?: (() => void) | undefined;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const refused = state === 'refused';

  return (
    <Box
      component="span"
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 2,
        maxWidth: '100%',
        height: 28,
        paddingInline: 3,
        borderRadius: '6px',
        backgroundColor: refused ? tokens['status.danger.tint'] : tokens['bg.muted'],
        color: refused ? tokens['status.danger.text'] : tokens['text.secondary'],
        border: `1px solid ${refused ? tokens['status.danger'] : tokens['border.default']}`,
      }}
    >
      {state === 'settling' ? (
        <CircularProgress size={12} aria-hidden="true" />
      ) : refused ? (
        <ShieldAlert size={14} aria-hidden="true" />
      ) : (
        <Paperclip size={14} aria-hidden="true" />
      )}

      <Typography component="span" variant="caption" noWrap sx={{ color: 'inherit', minWidth: 0 }}>
        <bdi>{name}</bdi>
        <span aria-hidden="true"> · </span>
        <bdi>{fileSize(size)}</bdi>
      </Typography>

      {state === 'settling' ? (
        <Typography component="span" variant="caption" sx={{ color: 'inherit' }}>
          {t('tickets:attachments.settling')}
        </Typography>
      ) : null}
      {refused ? (
        <Typography component="span" variant="caption" sx={{ color: 'inherit' }}>
          {t('tickets:attachments.refused')}
        </Typography>
      ) : null}

      {onRemove === undefined ? null : (
        <IconButton
          size="small"
          aria-label={t('tickets:attachments.remove', { name })}
          onClick={onRemove}
        >
          <X size={12} aria-hidden="true" />
        </IconButton>
      )}
    </Box>
  );
}

/** Which of the three a row is in, from the status the pipeline gave it. */
export const chipState = (attachment: Attachment): 'settling' | 'ready' | 'refused' => {
  if (attachment.status === 'ready') {
    return 'ready';
  }

  return attachment.status === 'pending' || attachment.status === 'processing'
    ? 'settling'
    : 'refused';
};
