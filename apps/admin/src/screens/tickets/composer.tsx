import type { TicketStatus } from '@helpdock/schemas';
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
import { statusName } from './format.js';
import { MESSAGE_MAX_WIDTH } from './message-bubble.tsx';

/**
 * DESIGN §6.3 Composer: the Reply / Internal note segmented control and the
 * recipient caption, the textarea, and a toolbar with attach, canned response,
 * translate, "then set status" and the primary send.
 *
 * Three of those five do nothing yet and say so on the control itself rather
 * than only in a tooltip: attachments are M1-10, canned responses are M3 and
 * translation is M7. A disabled control whose only explanation is a hover is
 * invisible to a keyboard and to a screen reader (DESIGN §10), so each carries
 * its sentence in `title` *and* in its accessible description.
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
  /** M1-10 has not landed, so the attach button is drawn and disabled. */
  readonly attachmentsAvailable: boolean;
  /**
   * Changes whenever `r` or `n` was pressed. The composer owns the caret
   * rather than being handed a ref, because the element the caret belongs in
   * is this component's and nobody else should have to know which one it is.
   */
  readonly focusSignal?: number | undefined;
  onModeChange(mode: ComposerMode): void;
  onBodyChange(body: string): void;
  onThenStatusChange(statusId: string): void;
  onSend(): void;
}

export function Composer({
  mode,
  body,
  recipient,
  statuses,
  thenStatusId,
  busy,
  attachmentsAvailable,
  focusSignal,
  onModeChange,
  onBodyChange,
  onThenStatusChange,
  onSend,
}: ComposerProps): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const { locale } = usePreferences();
  const bodyId = useId();
  const statusId = useId();
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
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

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
        <Unavailable
          available={attachmentsAvailable}
          reason={t('tickets:composer.attachUnavailable')}
        >
          <IconButton size="small" aria-label={t('tickets:composer.attach')} disabled>
            <Paperclip size={16} aria-hidden="true" />
          </IconButton>
        </Unavailable>

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

        <Button type="submit" variant="contained" disabled={busy || body.trim() === ''}>
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
