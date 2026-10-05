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
  Typography,
} from '@mui/material';
import { Paperclip, Send, Zap } from 'lucide-react';
import { type ReactNode, useId, useLayoutEffect, useRef } from 'react';
import { useT } from '../../app/i18n.js';
import { usePreferences } from '../../app/providers.tsx';
import { useSemanticTokens } from '../../app/tokens.js';
import { AttachmentChip, chipState } from './attachment-chip.tsx';
import {
  type ComposerEmail,
  FromSelect,
  RecipientLines,
  SignaturePreview,
} from './email-compose.tsx';
import { statusName } from './format.js';
import { MESSAGE_MAX_WIDTH } from './message-bubble.tsx';

/**
 * DESIGN §6.3 Composer: the Reply / Internal note segmented control and the
 * recipient caption, the textarea, and a toolbar with attach, Assist (M7-05),
 * canned response, "then set status" and the primary send. What assist
 * suggests sits above the textarea and never replaces the agent's text
 * without their say.
 *
 * **Macros and canned responses are M3-06.** The button opens the picker
 * (`macro-picker.tsx`), and so does `/` typed into an empty reply; what a macro
 * stages is drawn above the composer by the ticket view.
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
  /** The caret entered the body: M1-12's timer may start here. */
  onBodyFocus?(): void;
  /**
   * M2-05: a ticket that answers by email. A reply then shows its From, its
   * To and Cc, and the signature it will carry; a note is unchanged.
   */
  readonly email?: ComposerEmail | undefined;
  /**
   * M6-02: a ticket that answers in a Telegram chat. A reply then says which
   * chat it goes to and that the bot sends it as plain text, unsigned.
   */
  readonly telegram?: { readonly bot: string; readonly username: string | null } | undefined;
  /** M3-06: opens the macro picker. Absent for a reader who cannot reply. */
  onOpenMacros?: (() => void) | undefined;
  /** Whether the picker is open, for the button's `aria-expanded`. */
  readonly macrosOpen?: boolean | undefined;
  /** M7-05: the Assist button and its menu, when the brand runs agent assist. */
  readonly assist?: ReactNode;
  /** M7-05: a suggested reply, a rewrite or a translation waiting above the text. */
  readonly suggestion?: ReactNode;
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
  onBodyFocus,
  email,
  telegram,
  onOpenMacros,
  macrosOpen = false,
  assist,
  suggestion,
}: ComposerProps): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const { locale } = usePreferences();
  const bodyId = useId();
  const statusId = useId();
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const note = mode === 'note';
  const emailReply = email !== undefined && !note;
  const telegramReply = telegram !== undefined && !note;

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

        {emailReply ? (
          <FromSelect email={email} />
        ) : telegramReply ? (
          <Typography
            variant="caption"
            sx={{
              color: 'text.secondary',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 1,
              marginInlineStart: 'auto',
            }}
          >
            <Send size={14} aria-hidden="true" />
            {t('tickets:telegram.composerTo')}
            {telegram.username === null ? null : <bdi>@{telegram.username}</bdi>}
          </Typography>
        ) : (
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            {note
              ? t('tickets:composer.noteRecipient')
              : recipient === null
                ? t('tickets:composer.recipientUnknown')
                : t('tickets:composer.recipient', { name: recipient })}
          </Typography>
        )}
      </Box>

      {emailReply ? <RecipientLines email={email} /> : null}

      {suggestion}

      <TextField
        id={bodyId}
        inputRef={bodyRef}
        multiline
        minRows={3}
        value={body}
        onChange={(event) => {
          // `/` typed into an empty reply opens the picker instead of being text.
          if (body === '' && event.target.value === '/' && onOpenMacros !== undefined) {
            onOpenMacros();
            return;
          }
          onBodyChange(event.target.value);
        }}
        onFocus={onBodyFocus}
        placeholder={t(
          note ? 'tickets:composer.notePlaceholder' : 'tickets:composer.replyPlaceholder',
        )}
        slotProps={{ htmlInput: { 'aria-label': t('tickets:composer.bodyLabel') } }}
      />

      {emailReply ? <SignaturePreview signature={email.signature} /> : null}
      {telegramReply ? (
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          <bdi>{t('tickets:telegram.composerFoot', { bot: telegram.bot })}</bdi>
        </Typography>
      ) : null}

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

        {assist}

        <Button
          variant="text"
          size="small"
          disabled={onOpenMacros === undefined}
          aria-haspopup="dialog"
          aria-expanded={macrosOpen}
          startIcon={<Zap size={14} aria-hidden="true" />}
          onClick={onOpenMacros}
        >
          {t('tickets:composer.canned')}
        </Button>

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
          {t(
            note
              ? 'tickets:composer.sendNote'
              : emailReply
                ? 'tickets:email.send'
                : 'tickets:composer.send',
          )}
        </Button>
      </Box>
    </Paper>
  );
}
