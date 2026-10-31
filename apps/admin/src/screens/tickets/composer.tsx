import type { Attachment, CannedPlaceholder, Macro, TicketStatus } from '@helpdock/schemas';
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
import {
  type ReactNode,
  type SyntheticEvent,
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useT } from '../../app/i18n.js';
import { usePreferences } from '../../app/providers.tsx';
import { useSemanticTokens } from '../../app/tokens.js';
import {
  useAriaKeyShortcuts,
  useKeyboard,
  useShortcutHandlers,
} from '../../keyboard/keyboard-provider.tsx';
import type { ShortcutId } from '../../keyboard/registry.js';
import { PlaceholderPicker } from '../admin/automation/placeholder-picker.tsx';
import { AttachmentChip, chipState } from './attachment-chip.tsx';
import {
  MentionSuggestions,
  SavedReplySuggestions,
  type SuggestionKeys,
  type SuggestionList,
} from './composer-suggestions.tsx';
import { type ComposerTrigger, detectTrigger, replaceRange } from './composer-triggers.js';
import {
  type ComposerEmail,
  FromSelect,
  RecipientLines,
  SignaturePreview,
} from './email-compose.tsx';
import { statusName } from './format.js';
import { MESSAGE_MAX_WIDTH } from './message-bubble.tsx';
import { MetaCount, MetaRecipient } from './meta/composer-meta.tsx';
import type { ComposerMeta } from './meta/use-ticket-meta.tsx';

/**
 * DESIGN §6.3 Composer: the Reply / Internal note segmented control and the
 * recipient caption, the textarea, and a toolbar with attach, Assist (M7-05),
 * canned response, "then set status" and the primary send. What assist
 * suggests sits above the textarea and never replaces the agent's text
 * without their say.
 *
 * **Macros and canned responses are M3-06.** The button opens the picker
 * (`macro-picker.tsx`); what a macro stages is drawn above the composer by the
 * ticket view.
 *
 * **Typing opens lists (M14-14).** In a reply, `/` at the start of a line or
 * after a space lists the saved replies and macros under the text, narrowing as
 * the word after it grows (`/refund`, then Tab or Enter), unless single-key
 * shortcuts are off (the registry's `composer.savedReply` is one of them);
 * `{{` lists the placeholders and inserts the value this ticket gives it. A `/` inside a word
 * or a URL is text. The textarea keeps focus for the slash list; the
 * placeholder list takes it, as the editor's does.
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

/**
 * The composer's shortcuts (M14-01). They answer only while the caret is in
 * the composer (`data-shortcut-scope`). The registry's `composer.savedReply`
 * is not here: `/` is read from what is typed into an empty reply rather than
 * from the key, so it has no handler of its own (`SAVED_REPLY_TRIGGER`).
 */
export const COMPOSER_SHORTCUTS = [
  'composer.send',
  'composer.sendAndClose',
] as const satisfies readonly ShortcutId[];

/** What the composer needs to offer the lists that open as one types. */
export interface ComposerInline {
  readonly brandId: string;
  readonly departmentId: string;
  readonly ticketId: string;
  /** What each placeholder is for this ticket; one with no value is not offered. */
  readonly placeholderValues: ReadonlyMap<string, string>;
  /**
   * Insert a saved reply or macro in place of the `/word` at `[start, end)`.
   * Answers where the caret goes once the text is in, or null when nothing was
   * inserted (a macro that has no reply runs at once).
   */
  onInsertSaved(
    macro: Macro,
    range: { readonly start: number; readonly end: number },
  ): Promise<number | null>;
}

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
  /**
   * M14-01: send, then close the ticket (`⌘⇧Enter`). Absent when the brand
   * has no status to close into.
   */
  onSendAndClose?: (() => void) | undefined;
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
  /**
   * M10-08: a ticket that answers on WhatsApp, Messenger or Instagram. A reply
   * then names its recipient and account, counts the messages it becomes, and
   * while the reply window is closed holds Send (`aria-disabled`, described by
   * the strip). A note is unchanged and never held.
   */
  readonly meta?: ComposerMeta | undefined;
  /** M14-14: the lists that open under the text on `/` and `{{`. Absent for a reader who cannot reply. */
  readonly inline?: ComposerInline | undefined;
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
  onSendAndClose,
  onBodyFocus,
  email,
  telegram,
  meta,
  inline,
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
  const metaReply = meta !== undefined && !note;
  // Held, not disabled: the button keeps its place and its focus, so the reason
  // is read where the agent is. Nothing is sent while it is.
  const sendHeld = metaReply && meta.closed;
  const canSend = !sendHeld && !busy && !uploading && body.trim() !== '';
  const { singleKeys } = useKeyboard();
  const sendKeys = useAriaKeyShortcuts('composer.send');
  const replyKeys = useAriaKeyShortcuts('ticket.reply');
  const noteKeys = useAriaKeyShortcuts('ticket.note');
  const macrosKeys = useAriaKeyShortcuts('ticket.macros');

  useShortcutHandlers<(typeof COMPOSER_SHORTCUTS)[number]>({
    'composer.send': canSend ? onSend : null,
    'composer.sendAndClose': canSend && onSendAndClose !== undefined ? onSendAndClose : null,
  });

  // M14-14: the list the text under the caret asks for, and the one a person
  // has put away (kept by where it starts, so typing on does not reopen it).
  const listId = useId();
  const [trigger, setTrigger] = useState<ComposerTrigger | null>(null);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [activeOption, setActiveOption] = useState<string | null>(null);
  const suggestionKeys = useRef<SuggestionKeys | null>(null);
  const open = inline !== undefined && trigger !== null && trigger.start !== dismissedAt;
  const onActive = useCallback((id: string | null) => {
    setActiveOption(id);
  }, []);
  const dismiss = useCallback(() => {
    setDismissedAt(trigger?.start ?? null);
  }, [trigger]);
  const suggestionList: SuggestionList = {
    id: listId,
    onActive,
    keys: suggestionKeys,
    onDismiss: dismiss,
  };

  const syncTrigger = (area: HTMLInputElement | HTMLTextAreaElement): void => {
    const caret = area.selectionStart;
    const found =
      inline === undefined || caret === null || caret !== area.selectionEnd
        ? null
        : detectTrigger(area.value, caret, { slash: !note && singleKeys, mention: note });
    setTrigger(found);
    if (found === null) {
      setDismissedAt(null);
    }
  };

  const insertAtTrigger = (text: string): void => {
    if (trigger === null) {
      return;
    }
    const { text: next, caret } = replaceRange(body, trigger.start, trigger.end, text);
    onBodyChange(next);
    setTrigger(null);
    setDismissedAt(null);
    requestAnimationFrame(() => {
      bodyRef.current?.focus();
      bodyRef.current?.setSelectionRange(caret, caret);
    });
  };

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
      data-shortcut-scope="composer"
      onSubmit={(event) => {
        event.preventDefault();
        if (!sendHeld) {
          onSend();
        }
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
          <ToggleButton value="reply" aria-keyshortcuts={replyKeys}>
            {t('tickets:composer.reply')}
          </ToggleButton>
          <ToggleButton value="note" aria-keyshortcuts={noteKeys}>
            {t('tickets:composer.note')}
          </ToggleButton>
        </ToggleButtonGroup>

        {emailReply ? (
          <FromSelect email={email} />
        ) : metaReply ? (
          <MetaRecipient meta={meta} />
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
          onBodyChange(event.target.value);
          syncTrigger(event.target);
        }}
        onKeyDown={(event) => {
          // The open list gets the key first; it says whether it used it.
          if (open && suggestionKeys.current?.(event) === true) {
            event.stopPropagation();
          }
        }}
        onFocus={onBodyFocus}
        placeholder={t(
          note ? 'tickets:composer.notePlaceholder' : 'tickets:composer.replyPlaceholder',
        )}
        slotProps={{
          htmlInput: {
            'aria-label': t('tickets:composer.bodyLabel'),
            ...(open && trigger.kind !== 'placeholder'
              ? {
                  'aria-controls': listId,
                  ...(activeOption === null ? {} : { 'aria-activedescendant': activeOption }),
                }
              : {}),
            // A click or an arrow key moves the caret without changing the text.
            onSelect: (event: SyntheticEvent<HTMLTextAreaElement>) => {
              syncTrigger(event.currentTarget);
            },
          },
        }}
      />

      {open && trigger.kind === 'slash' ? (
        <SavedReplySuggestions
          brandId={inline.brandId}
          departmentId={inline.departmentId}
          query={trigger.query}
          list={suggestionList}
          onPick={(macro) => {
            const range = { start: trigger.start, end: trigger.end };
            setTrigger(null);
            void inline.onInsertSaved(macro, range).then((caret) => {
              requestAnimationFrame(() => {
                bodyRef.current?.focus();
                if (caret !== null) {
                  bodyRef.current?.setSelectionRange(caret, caret);
                }
              });
            });
          }}
        />
      ) : null}
      {open && trigger.kind === 'mention' ? (
        <MentionSuggestions
          brandId={inline.brandId}
          ticketId={inline.ticketId}
          query={trigger.query}
          list={suggestionList}
          onPick={(handle) => {
            insertAtTrigger(`@${handle} `);
          }}
        />
      ) : null}
      {open && trigger.kind === 'placeholder' ? (
        <PlaceholderPicker
          samples={inline.placeholderValues}
          names={[...inline.placeholderValues]
            .filter(([, value]) => value.trim() !== '')
            .map(([name]) => name as CannedPlaceholder)}
          hint={t('tickets:composer.suggest.placeholderHint')}
          onPick={(name) => {
            insertAtTrigger(inline.placeholderValues.get(name) ?? '');
          }}
          onClose={() => {
            setDismissedAt(trigger.start);
            bodyRef.current?.focus();
          }}
        />
      ) : null}

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

      {metaReply ? <MetaCount meta={meta} body={body} attachments={attachments} /> : null}

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
          aria-keyshortcuts={macrosKeys}
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
          disabled={!sendHeld && (busy || uploading || body.trim() === '')}
          aria-disabled={sendHeld ? true : undefined}
          aria-keyshortcuts={sendKeys}
          aria-describedby={sendHeld ? meta.stripId : undefined}
          onClick={(event) => {
            if (sendHeld) {
              event.preventDefault();
            }
          }}
          sx={
            sendHeld
              ? {
                  backgroundColor: tokens['bg.muted'],
                  color: tokens['text.disabled'],
                  cursor: 'not-allowed',
                  '&:hover, &:active': { backgroundColor: tokens['bg.muted'] },
                }
              : undefined
          }
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
