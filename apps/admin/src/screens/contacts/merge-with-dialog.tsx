import type { ContactSummary } from '@helpdock/schemas';
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
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Search, X } from 'lucide-react';
import { type ReactNode, useEffect, useId, useState } from 'react';
import { useT } from '../../app/i18n.js';
import { useSemanticTokens } from '../../app/tokens.js';
import { currentBrand, useContactsApi, useSession } from '../../auth/session.tsx';
import { useDebounced } from '../../ui/use-debounced.js';
import { identityLabel } from './format.js';
import { ContactAvatar } from './identity-pieces.tsx';

/**
 * "Merge with…" — panel 5 of `Admin · view dialogs` (M1-15 part 2): pick any
 * other contact to merge with, then hand over to the Merge contacts dialog
 * (M1-13), which is where the survivor is chosen.
 *
 * The search is the contact list's own read with `mergeable=true`, so the api
 * leaves out anonymised contacts (a merge refuses them) and never lists merged
 * ones; this dialog leaves out the contact it was opened on. How many
 * candidates a page holds is the list's business: the first ten matches, and a
 * narrower search for the rest.
 */

const SEARCH_DEBOUNCE_MS = 250;
const CANDIDATES = 10;

export const mergeWithCandidates = (
  contacts: readonly ContactSummary[],
  contactId: string,
): ContactSummary[] => contacts.filter((contact) => contact.id !== contactId);

export function MergeWithDialog({
  open,
  contact,
  onClose,
  onContinue,
}: {
  readonly open: boolean;
  /** The contact whose page this is. */
  readonly contact: { readonly id: string; readonly name: string };
  onClose(): void;
  onContinue(otherContactId: string): void;
}): ReactNode {
  const t = useT();
  const session = useSession();
  const api = useContactsApi();
  const tokens = useSemanticTokens();
  const titleId = useId();
  const hintId = useId();
  const brand = currentBrand(session);
  const [term, setTerm] = useState('');
  const [chosen, setChosen] = useState<string | null>(null);
  const search = useDebounced(term.trim(), SEARCH_DEBOUNCE_MS);

  // Reopened, it starts clean: a choice left ticked would merge the wrong pair.
  useEffect(() => {
    if (open) {
      setTerm('');
      setChosen(null);
    }
  }, [open]);

  const found = useQuery({
    queryKey: ['contacts', brand.id, 'mergeable', search],
    queryFn: () =>
      api.listContacts(brand.id, {
        mergeable: true,
        limit: CANDIDATES + 1,
        ...(search === '' ? {} : { search }),
      }),
    enabled: open,
    // The last answer stays up while the next is read, so a choice being
    // clicked is not pulled from under the pointer.
    placeholderData: keepPreviousData,
  });

  const candidates = mergeWithCandidates(found.data?.contacts ?? [], contact.id).slice(
    0,
    CANDIDATES,
  );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullWidth
      aria-labelledby={titleId}
      slotProps={{ paper: { sx: { maxWidth: 520, borderRadius: '14px' } } }}
    >
      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 3, paddingInlineEnd: 4 }}>
        <DialogTitle id={titleId} sx={{ flex: 1, fontSize: 18, fontWeight: 600 }}>
          {t('contacts:mergeWith.title', { name: contact.name })}
          <Typography
            variant="body2"
            component="span"
            sx={{ display: 'block', color: 'text.secondary', fontWeight: 400 }}
          >
            {t('contacts:mergeWith.subtitle')}
          </Typography>
        </DialogTitle>
        <IconButton
          size="small"
          aria-label={t('common:actions.cancel')}
          onClick={onClose}
          sx={{ marginBlockStart: 4 }}
        >
          <X size={16} aria-hidden="true" />
        </IconButton>
      </Box>

      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <TextField
          type="search"
          size="small"
          label={t('contacts:mergeWith.searchLabel')}
          value={term}
          onChange={(event) => {
            setTerm(event.target.value);
          }}
          slotProps={{
            htmlInput: { 'aria-describedby': hintId },
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <Search size={16} aria-hidden="true" />
                </InputAdornment>
              ),
            },
          }}
        />

        {found.isSuccess && candidates.length === 0 ? (
          <Typography variant="body2" role="status" sx={{ color: 'text.secondary' }}>
            {t('contacts:mergeWith.none')}
          </Typography>
        ) : (
          <Box
            role="radiogroup"
            aria-label={t('contacts:mergeWith.results')}
            aria-busy={found.isPending}
            sx={{
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
              maxHeight: 280,
              overflowY: 'auto',
            }}
          >
            {candidates.map((candidate) => {
              const selected = candidate.id === chosen;

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
                    borderRadius: '8px',
                    cursor: 'pointer',
                    border: selected
                      ? `2px solid ${tokens['action.primary']}`
                      : `1px solid ${tokens['border.default']}`,
                    backgroundColor: selected
                      ? tokens['action.primary.tint']
                      : tokens['bg.surface'],
                  }}
                >
                  <Radio
                    size="small"
                    name="merge-with"
                    checked={selected}
                    value={candidate.id}
                    onChange={() => {
                      setChosen(candidate.id);
                    }}
                    sx={{ padding: 0 }}
                  />
                  <ContactAvatar name={candidate.name} />
                  <Box sx={{ display: 'flex', flexDirection: 'column', minWidth: 0, flexGrow: 1 }}>
                    <Typography variant="bodyStrong" component="span" noWrap>
                      {candidate.name}
                    </Typography>
                    {candidate.primaryIdentity === null ? null : (
                      <Typography
                        variant="caption"
                        component="span"
                        noWrap
                        sx={{ color: 'text.secondary' }}
                      >
                        <bdi>{identityLabel(candidate.primaryIdentity)}</bdi>
                      </Typography>
                    )}
                  </Box>
                  <Typography
                    variant="caption"
                    component="span"
                    sx={{ color: 'text.secondary', flexShrink: 0 }}
                  >
                    {t('contacts:merge.tickets', { count: candidate.stats.totalTickets })}
                  </Typography>
                </Box>
              );
            })}
          </Box>
        )}

        <Typography id={hintId} variant="caption" sx={{ color: 'text.secondary' }}>
          {t('contacts:mergeWith.hint')}
        </Typography>
      </DialogContent>

      <DialogActions
        sx={{ padding: 4, gap: 2, borderBlockStart: `1px solid ${tokens['border.default']}` }}
      >
        <Button variant="text" onClick={onClose}>
          {t('common:actions.cancel')}
        </Button>
        <Button
          variant="contained"
          disabled={chosen === null}
          onClick={() => {
            if (chosen !== null) {
              onContinue(chosen);
            }
          }}
        >
          {t('contacts:mergeWith.continue')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
