import type { Ticket, TicketSpamSender } from '@helpdock/schemas';
import { Box, Checkbox, FormControlLabel, Typography } from '@mui/material';
import { type ReactNode, useEffect, useState } from 'react';
import { useT } from '../../app/i18n.js';
import { useSemanticTokens } from '../../app/tokens.js';
import { ConfirmDialog } from '../../ui/confirm-dialog.tsx';
import { ticketReference } from './format.js';

/**
 * "Mark as spam" (`Admin · ticket dialogs`, panel 5): one sentence saying what
 * spam means, and — only when the api says so — a ticked "Block <sender>"
 * card.
 *
 * The checkbox is drawn when the brand offers it (Ticketing › Spam), the
 * ticket has a sender that can be blocked, that sender is not one of the
 * brand's own addresses, and it is not blocked already. All four are the api's
 * answer (`GET …/spam-sender`), read when the dialog opens, because two of
 * them need data the workspace does not hold.
 *
 * Until that answer arrives the dialog shows the sentence alone; the primary
 * is usable at once, because marking without blocking is always allowed.
 */

/** Whether the "Block sender" checkbox is drawn for this answer. */
export const offersBlock = (answer: TicketSpamSender | undefined): boolean =>
  answer !== undefined &&
  answer.sender !== null &&
  answer.offered &&
  answer.blockable &&
  !answer.blocked;

export function MarkSpamDialog({
  open,
  ticket,
  sender,
  busy,
  onConfirm,
  onClose,
}: {
  readonly open: boolean;
  readonly ticket: Ticket;
  /** The api's answer, or undefined while it is being read. */
  readonly sender: TicketSpamSender | undefined;
  readonly busy: boolean;
  onConfirm(blockSender: boolean): void;
  onClose(): void;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const offered = offersBlock(sender);
  // Ticked by default, as the artboard draws it: an agent marking spam almost
  // always wants the next one stopped too.
  const [block, setBlock] = useState(true);

  useEffect(() => {
    if (open) {
      setBlock(true);
    }
  }, [open]);

  return (
    <ConfirmDialog
      open={open}
      destructive
      busy={busy}
      title={t('tickets:spam.title', { ticket: ticketReference(ticket) })}
      body={t('tickets:spam.body')}
      confirmLabel={t('tickets:spam.submit')}
      onClose={onClose}
      onConfirm={() => {
        onConfirm(offered && block);
      }}
    >
      {offered && sender?.sender != null ? (
        <FormControlLabel
          sx={{
            alignItems: 'flex-start',
            gap: 3,
            marginInline: 0,
            paddingBlock: 3,
            paddingInline: '14px',
            borderRadius: '8px',
            border: `1px solid ${tokens['border.default']}`,
          }}
          control={
            <Checkbox
              checked={block}
              sx={{ padding: 0, marginBlockStart: '2px' }}
              onChange={(event) => {
                setBlock(event.target.checked);
              }}
            />
          }
          label={
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
              <Typography component="span" sx={{ fontWeight: 500 }}>
                {t('tickets:spam.block')}{' '}
                <Typography variant="mono" component="bdi">
                  {sender.sender.value}
                </Typography>
              </Typography>
              <Typography
                variant="caption"
                component="span"
                sx={{ color: 'text.secondary', fontSize: 13 }}
              >
                {t('tickets:spam.blockHint')}
              </Typography>
            </Box>
          }
        />
      ) : null}
    </ConfirmDialog>
  );
}
