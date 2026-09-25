import type { Department, Ticket } from '@helpdock/schemas';
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  InputAdornment,
  Radio,
  TextField,
  Typography,
} from '@mui/material';
import { Search, X } from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useId, useState } from 'react';
import { useT } from '../../app/i18n.js';
import { useSemanticTokens } from '../../app/tokens.js';
import { isolate, ticketReference } from './format.js';

/**
 * "Merge tickets" — panel 1 of `AdminTicketDialogs` (M1-09, DOMAIN-RULES §2.4).
 *
 * The ticket the dialog was opened on is always the one that closes; the list
 * is what it can close *into*. The candidates are whatever the list read
 * answered for the search, which is already every ticket this person may read
 * in any department and none they may not — the api's policy decides that, not
 * this screen. The box under the list says what the merge will do, naming both
 * tickets, so nobody merges the wrong way round by accident.
 */
export function MergeDialog({
  open,
  ticket,
  candidates,
  departments,
  contactName,
  busy,
  onTermChange,
  onSubmit,
  onClose,
}: {
  readonly open: boolean;
  /** The ticket being merged: the secondary. */
  readonly ticket: Ticket;
  /** What the search answered, the secondary and merged tickets already left out. */
  readonly candidates: readonly Ticket[];
  readonly departments: readonly Department[];
  /** A contact's display name, or null when the directory does not know it. */
  contactName(contactId: string | null): string | null;
  readonly busy: boolean;
  onTermChange(term: string): void;
  onSubmit(primaryTicketId: string): void;
  onClose(): void;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const titleId = useId();
  const searchId = useId();
  const hintId = useId();
  const [term, setTerm] = useState('');
  const [primaryId, setPrimaryId] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  // A dialog that reopened with the last choice still ticked would merge into
  // the wrong ticket on a mis-click.
  useEffect(() => {
    if (open) {
      setTerm('');
      setPrimaryId(null);
      setProblem(null);
    }
  }, [open]);

  const primary = candidates.find((candidate) => candidate.id === primaryId) ?? null;
  const secondaryReference = ticketReference(ticket);
  const secondaryContact = contactName(ticket.contactId);
  const addsCc =
    primary !== null && ticket.contactId !== null && ticket.contactId !== primary.contactId;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (primary === null) {
      setProblem(t('tickets:merge.pickOne'));
      return;
    }

    onSubmit(primary.id);
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullWidth
      aria-labelledby={titleId}
      slotProps={{ paper: { sx: { maxWidth: 520 } } }}
    >
      <Box component="form" noValidate onSubmit={submit}>
        <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 3, paddingInlineEnd: 4 }}>
          <DialogTitle id={titleId} sx={{ flex: 1, fontSize: 18, fontWeight: 600 }}>
            {t('tickets:merge.title')}
            <Typography
              variant="body2"
              component="span"
              sx={{ display: 'block', color: 'text.secondary', fontWeight: 400 }}
            >
              {t('tickets:merge.description')}
            </Typography>
          </DialogTitle>
          <IconButton
            size="small"
            aria-label={t('tickets:actions.closeDialog')}
            onClick={onClose}
            sx={{ marginBlockStart: 4 }}
          >
            <X size={16} aria-hidden="true" />
          </IconButton>
        </Box>

        <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <TextField
            id={searchId}
            type="search"
            size="small"
            label={t('tickets:merge.searchLabel', { reference: secondaryReference })}
            value={term}
            onChange={(event) => {
              setTerm(event.target.value);
              onTermChange(event.target.value);
            }}
            helperText={t('tickets:merge.searchHint')}
            slotProps={{
              formHelperText: { id: hintId },
              input: {
                startAdornment: (
                  <InputAdornment position="start">
                    <Search size={16} aria-hidden="true" />
                  </InputAdornment>
                ),
              },
            }}
          />

          {candidates.length === 0 ? (
            <Typography variant="body2" role="status" sx={{ color: 'text.secondary' }}>
              {t('tickets:merge.noMatches')}
            </Typography>
          ) : (
            <Box
              role="radiogroup"
              aria-label={t('tickets:merge.candidates')}
              aria-describedby={problem === null ? undefined : `${hintId}-problem`}
              sx={{
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
                maxHeight: 240,
                overflowY: 'auto',
              }}
            >
              {candidates.map((candidate) => {
                const chosen = candidate.id === primaryId;
                const department =
                  departments.find((row) => row.id === candidate.departmentId)?.name ?? '';

                return (
                  <Box
                    component="label"
                    key={candidate.id}
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 3,
                      paddingBlock: 2,
                      paddingInline: 3,
                      borderRadius: '6px',
                      cursor: 'pointer',
                      border: chosen
                        ? `2px solid ${tokens['action.primary']}`
                        : `1px solid ${tokens['border.default']}`,
                      backgroundColor: chosen
                        ? tokens['action.primary.tint']
                        : tokens['bg.surface'],
                    }}
                  >
                    <Radio
                      size="small"
                      name="primary"
                      checked={chosen}
                      value={candidate.id}
                      onChange={() => {
                        setPrimaryId(candidate.id);
                        setProblem(null);
                      }}
                      sx={{ padding: 0 }}
                    />
                    <Box sx={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }}>
                      <Typography variant="bodyStrong" component="span" noWrap>
                        {candidate.subject}
                      </Typography>
                      <Typography
                        variant="caption"
                        component="span"
                        sx={{ color: 'text.secondary', display: 'flex', gap: 2, flexWrap: 'wrap' }}
                      >
                        <Typography variant="mono" component="bdi" sx={{ fontSize: 12 }}>
                          {ticketReference(candidate)}
                        </Typography>
                        {contactName(candidate.contactId) === null ? null : (
                          <span>{contactName(candidate.contactId)}</span>
                        )}
                        <span>
                          {candidate.status.systemState === 'closed'
                            ? t('tickets:merge.closedSuffix', { department })
                            : department}
                        </span>
                      </Typography>
                    </Box>
                  </Box>
                );
              })}
            </Box>
          )}

          {problem === null ? null : (
            <Typography
              id={`${hintId}-problem`}
              variant="caption"
              role="alert"
              sx={{ color: tokens['status.danger.text'] }}
            >
              {problem}
            </Typography>
          )}

          <Box
            sx={{
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
              paddingBlock: 3,
              paddingInline: 4,
              borderRadius: '6px',
              backgroundColor: tokens['bg.canvas'],
              fontSize: 13,
            }}
          >
            <Typography component="p" sx={{ fontSize: 13, fontWeight: 600 }}>
              {t('tickets:merge.consequencesTitle', { reference: isolate(secondaryReference) })}
            </Typography>
            <Typography component="p" sx={{ fontSize: 13 }}>
              {t('tickets:merge.closes')}
            </Typography>
            {primary === null ? null : (
              <Typography component="p" sx={{ fontSize: 13 }}>
                {t('tickets:merge.messages', { primary: isolate(ticketReference(primary)) })}
              </Typography>
            )}
            <Typography component="p" sx={{ fontSize: 13 }}>
              {addsCc && primary !== null && secondaryContact !== null
                ? t('tickets:merge.tagsAndCc', {
                    name: secondaryContact,
                    primary: isolate(ticketReference(primary)),
                  })
                : t('tickets:merge.tags')}
            </Typography>
            <Typography component="p" sx={{ fontSize: 13 }}>
              {t('tickets:merge.undo')}
            </Typography>
          </Box>
        </DialogContent>

        <DialogActions
          sx={{ padding: 4, gap: 2, borderBlockStart: `1px solid ${tokens['bg.muted']}` }}
        >
          <Button variant="text" onClick={onClose} disabled={busy}>
            {t('common:actions.cancel')}
          </Button>
          <Button type="submit" variant="contained" disabled={busy}>
            {primary === null
              ? t('tickets:merge.submitNone')
              : t('tickets:merge.submit', { reference: ticketReference(primary) })}
          </Button>
        </DialogActions>
      </Box>
    </Dialog>
  );
}
