import type { Attachment, TicketStatus } from '@helpdock/schemas';
import {
  Box,
  Button,
  IconButton,
  MenuItem,
  Paper,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import { Languages, Paperclip, Zap } from 'lucide-react';
import { type ReactNode, useId, useLayoutEffect, useRef } from 'react';
import { useT } from '../../app/i18n.js';
import { usePreferences } from '../../app/providers.tsx';
import { useSemanticTokens } from '../../app/tokens.js';
import { AttachmentChip, chipState } from './attachment-chip.tsx';
import { statusName } from './format.js';
import { MESSAGE_MAX_WIDTH } from './message-bubble.tsx';

/**
 * DESIGN §6.3 Composer: the Reply / Internal note segmented control and the
 * recipient caption, the textarea, and a toolbar with attach, canned response,
 * translate, "then set status" and the primary send.
 *
 * Two of those five do nothing yet and say so on the control itself rather than
 * only in a tooltip: canned responses are M3 and translation is M7. A disabled
 * control whose only explanation is a hover is invisible to a keyboard and to a
 * screen reader (DESIGN §10), so each carries its sentence in text only a
 * screen reader reads.
 *
 * **Attach is real from M1-10.** A file goes up as soon as it is chosen and the
 * message may be sent while the pipeline is still working on it: `upload`
 * resolves at `processing`, the ids travel with the send, and the api links
 * them in the same transaction. A file the brand's policy would refuse is
 * refused here, in the picker, rather than after a minute of uploading — and
 * again by the api, because a client's opinion is not an authorisation.
 *
 * **Note mode tints the whole card.** It is the one state where getting it
 * wrong is unrecoverable — a note posted as a public reply has left the
 * building — so the mode is not a small toggle in a corner, it is the colour of
 * everything the person is looking at.
 */

export type ComposerMode = 'reply' | 'note';

export interface ComposerProps {
  readonly mode: ComposerMode;
  readonly body: string;
  readonly recipient: string | null;
  readonly statuses: readonly TicketStatus[];
  /** The status to move to after a successful send, or '' to leave it alone. */
  readonly thenStatusId: string;
  readonly busy: boolean;
  /** What has been uploaded and not yet sent, in the order it was chosen. */
  readonly attachments: readonly Attachment[];
  /** True while a file is still going up; the send waits for it. */
  readonly uploading: boolean;
  /** Null while the brand's policy has not been read; the button waits for it. */
  readonly attachmentsEnabled: boolean;
  /**
   * Changes whenever `r` or `n` was pressed. The composer owns the caret
   * rather than being handed a ref, because the element the caret belongs in
   * is this component's and nobody else should have to know which one it is.
   */
  readonly focusSignal?: number | undefined;
  onModeChange(mode: ComposerMode): void;
  onBodyChange(body: string): void;
  onThenStatusChange(statusId: string): void;
  onAttach(files: readonly File[]): void;
  onRemoveAttachment(attachmentId: string): void;
  onSend(): void;
}

export function Composer({
  mode,
  body,
  recipient,
  statuses,
  thenStatusId,
  busy,
  attachments,
  uploading,
  attachmentsEnabled,
  focusSignal,
  onModeChange,
  onBodyChange,
  onThenStatusChange,
  onAttach,
  onRemoveAttachment,
  onSend,
}: ComposerProps): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const { locale } = usePreferences();
  const bodyId = useId();
  const statusId = useId();
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const note = mode === 'note';

  // A layout effect: refs are attached and the caret moves before the browser
  // paints, so `r` never shows a frame of the composer without a caret in it.
  useLayoutEffect(() => {
    if (focusSignal !== undefined) {
      bodyRef.current?.focus();
    }
  }, [focusSignal]);

  return (
    <Paper
      component="form"
      elevation={1}
      aria-label={t('tickets:composer.label')}
      onSubmit={(event) => {
        event.preventDefault();
        onSend();
      }}
      sx={{
        width: '100%',
        maxWidth: MESSAGE_MAX_WIDTH,
        marginInline: 'auto',
        padding: 4,
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
        backgroundColor: note ? tokens['status.warning.tint'] : tokens['bg.surface'],
        border: `1px solid ${note ? tokens['status.warning'] : tokens['border.default']}`,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 3, flexWrap: 'wrap' }}>
        <ToggleButtonGroup
          exclusive
          size="small"
          value={mode}
          aria-label={t('tickets:composer.label')}
          onChange={(_event, next: ComposerMode | null) => {
            if (next !== null) {
              onModeChange(next);
            }
          }}
        >
          <ToggleButton value="reply">{t('tickets:composer.reply')}</ToggleButton>
          <ToggleButton value="note">{t('tickets:composer.note')}</ToggleButton>
        </ToggleButtonGroup>

        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          {note
            ? t('tickets:composer.noteRecipient')
            : recipient === null
              ? t('tickets:composer.recipientUnknown')
              : t('tickets:composer.recipient', { name: recipient })}
        </Typography>
      </Box>

      <TextField
        id={bodyId}
        inputRef={bodyRef}
        multiline
        minRows={3}
        value={body}
        onChange={(event) => {
          onBodyChange(event.target.value);
        }}
        placeholder={t(
          note ? 'tickets:composer.notePlaceholder' : 'tickets:composer.replyPlaceholder',
        )}
        slotProps={{ htmlInput: { 'aria-label': t('tickets:composer.bodyLabel') } }}
      />

      {attachments.length === 0 ? null : (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2 }}>
          {attachments.map((attachment) => (
            <AttachmentChip
              key={attachment.id}
              name={attachment.originalName}
              size={attachment.size}
              state={chipState(attachment)}
              onRemove={() => {
                onRemoveAttachment(attachment.id);
              }}
            />
          ))}
        </Box>
      )}

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          // Named, not hidden from assistive technology: `hidden` already
          // keeps it off the screen, and the button above is what opens it.
          aria-label={t('tickets:composer.attachFiles')}
          tabIndex={-1}
          onChange={(event) => {
            const chosen = [...(event.target.files ?? [])];
            // Cleared so that choosing the same file twice in a row is two
            // events rather than one; a browser fires nothing for a repeat.
            event.target.value = '';
            if (chosen.length > 0) {
              onAttach(chosen);
            }
          }}
        />
        <IconButton
          size="small"
          aria-label={t('tickets:composer.attach')}
          disabled={!attachmentsEnabled || uploading}
          onClick={() => {
            fileRef.current?.click();
          }}
        >
          <Paperclip size={16} aria-hidden="true" />
        </IconButton>

        <Unavailable available={false} reason={t('tickets:composer.cannedUnavailable')}>
          <Button
            variant="text"
            size="small"
            disabled
            startIcon={<Zap size={14} aria-hidden="true" />}
          >
            {t('tickets:composer.canned')}
          </Button>
        </Unavailable>

        <Unavailable available={false} reason={t('tickets:composer.translateUnavailable')}>
          <Button
            variant="text"
            size="small"
            disabled
            startIcon={<Languages size={14} aria-hidden="true" />}
          >
            {t('tickets:composer.translate')}
          </Button>
        </Unavailable>

        <TextField
          id={statusId}
          select
          size="small"
          value={thenStatusId}
          label={t('tickets:composer.thenSetStatus')}
          onChange={(event) => {
            onThenStatusChange(event.target.value);
          }}
          sx={{ minWidth: 180, marginInlineStart: 'auto' }}
        >
          <MenuItem value="">{t('tickets:composer.keepStatus')}</MenuItem>
          {statuses.map((status) => (
            <MenuItem key={status.id} value={status.id}>
              {statusName(status, locale)}
            </MenuItem>
          ))}
        </TextField>

        <Button
          type="submit"
          variant="contained"
          disabled={busy || uploading || body.trim() === ''}
        >
          {t(note ? 'tickets:composer.sendNote' : 'tickets:composer.send')}
        </Button>
      </Box>
    </Paper>
  );
}

/**
 * A control a later milestone turns on. The reason travels as a tooltip *and*
 * as text only a screen reader reads, because a tooltip is never the only
 * carrier of meaning (DESIGN §6.4) and a disabled control cannot be hovered
 * by a keyboard at all.
 */
function Unavailable({
  available,
  reason,
  children,
}: {
  readonly available: boolean;
  readonly reason: string;
  readonly children: ReactNode;
}): ReactNode {
  if (available) {
    return children;
  }

  return (
    <Tooltip title={reason}>
      <Box component="span" sx={{ display: 'inline-flex' }}>
        {children}
        <Box component="span" sx={visuallyHidden}>
          {reason}
        </Box>
      </Box>
    </Tooltip>
  );
}

/** Read by a screen reader, drawn for nobody. */
const visuallyHidden = {
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  clipPath: 'inset(50%)',
  whiteSpace: 'nowrap',
} as const;
