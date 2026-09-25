import type { ContactMergePreview, ContactMergeSide } from '@helpdock/schemas';
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Radio,
  RadioGroup,
  Typography,
} from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { Info } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { useT } from '../../app/i18n.js';
import { useSemanticTokens } from '../../app/tokens.js';
import { currentBrand, useContactsApi, useSession } from '../../auth/session.tsx';
import { identityLabel } from './format.js';
import { CHANNEL_ICONS } from './identity-pieces.tsx';

/**
 * `Merge contacts` (M1-13), panel 1 of `Admin/Contact dialogs`.
 *
 * The agent picks **whose name and details survive**; the other contact's
 * identifiers, notes and tickets move onto it. The list under the choice is
 * the union of identifiers as they will be afterwards, each with its own
 * state: verification never upgrades by merging (DOMAIN-RULES §4.4), so an
 * address somebody typed is still "unverified" beside a proven one.
 *
 * Ticket counts include the tickets in departments the viewer is not in: they
 * move too, and DOMAIN-RULES §1.2 lets a count of hidden tickets be shown.
 *
 * The artboard draws the identifiers as ticked checkboxes. They are drawn here
 * as a plain list, because every identifier is kept — a checkbox that cannot be
 * unticked would be a control that does nothing.
 */
export function MergeContactsDialog({
  open,
  contactId,
  otherContactId,
  reason,
  busy,
  onClose,
  onMerge,
}: {
  readonly open: boolean;
  /** The contact whose page this is. */
  readonly contactId: string;
  readonly otherContactId: string;
  /** Why the pair was suggested, already in words; null for a merge not made from a suggestion. */
  readonly reason: string | null;
  readonly busy: boolean;
  onClose(): void;
  onMerge(choice: { survivor: ContactMergeSide; merged: ContactMergeSide }): void;
}): ReactNode {
  const t = useT();
  const session = useSession();
  const api = useContactsApi();
  const tokens = useSemanticTokens();
  const titleId = useId();
  const brand = currentBrand(session);
  const [survivorId, setSurvivorId] = useState(contactId);
  const [pair, setPair] = useState(`${contactId}:${otherContactId}`);

  // Opened for another pair: start again from "keep the contact you are on".
  if (pair !== `${contactId}:${otherContactId}`) {
    setPair(`${contactId}:${otherContactId}`);
    setSurvivorId(contactId);
  }

  const preview = useQuery({
    queryKey: ['contact-merge-preview', brand.id, contactId, otherContactId],
    queryFn: () => api.mergePreview(brand.id, contactId, otherContactId),
    enabled: open,
  });

  const data = preview.data;
  const sides = data === undefined ? [] : [data.contact, data.other];
  const survivor = sides.find((side) => side.id === survivorId);
  const merged = sides.find((side) => side.id !== survivorId);

  return (
    <Dialog
      open={open}
      onClose={() => {
        if (!busy) {
          onClose();
        }
      }}
      maxWidth="sm"
      fullWidth
      aria-labelledby={titleId}
      slotProps={{ paper: { sx: { maxWidth: 520, borderRadius: '14px' } } }}
    >
      <DialogTitle id={titleId} sx={{ fontSize: 18, fontWeight: 600 }}>
        {t('contacts:merge.title')}
        <Typography
          variant="body2"
          component="span"
          sx={{ display: 'block', color: 'text.secondary', fontWeight: 400 }}
        >
          {data === undefined
            ? t('contacts:merge.loading')
            : reason === null
              ? t('contacts:merge.subtitleManual')
              : t('contacts:merge.subtitle', { name: data.other.name, reason })}
        </Typography>
      </DialogTitle>

      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {data === undefined ? null : (
          <>
            <Box component="fieldset" sx={{ border: 0, margin: 0, padding: 0 }}>
              <Typography
                component="legend"
                variant="body2"
                sx={{ fontWeight: 500, paddingBlockEnd: 2 }}
              >
                {t('contacts:merge.keep')}
              </Typography>
              <RadioGroup
                row
                value={survivorId}
                onChange={(event) => {
                  setSurvivorId(event.target.value);
                }}
                sx={{ gap: 3, flexWrap: 'nowrap' }}
              >
                {sides.map((side) => (
                  <SideOption key={side.id} side={side} selected={side.id === survivorId} />
                ))}
              </RadioGroup>
            </Box>

            <Identities preview={data} />

            <Box sx={{ display: 'flex', gap: 2, color: 'text.secondary' }}>
              <Info
                size={16}
                aria-hidden="true"
                color={tokens['text.secondary']}
                style={{ flexShrink: 0, marginBlockStart: 2 }}
              />
              <Typography variant="body2" sx={{ color: 'inherit' }}>
                {t('contacts:merge.note', { name: survivor?.name ?? '' })}
              </Typography>
            </Box>
          </>
        )}
      </DialogContent>

      <DialogActions
        sx={{ padding: 4, gap: 2, borderBlockStart: `1px solid ${tokens['border.default']}` }}
      >
        <Button variant="text" onClick={onClose} disabled={busy}>
          {t('common:actions.cancel')}
        </Button>
        <Button
          variant="contained"
          disabled={busy || survivor === undefined || merged === undefined}
          onClick={() => {
            if (survivor !== undefined && merged !== undefined) {
              onMerge({ survivor, merged });
            }
          }}
        >
          {t('contacts:merge.submit')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/** One of the two "keep" choices: a bordered card with the radio, the account and the ticket count. */
function SideOption({
  side,
  selected,
}: {
  readonly side: ContactMergeSide;
  readonly selected: boolean;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();

  return (
    <FormControlLabel
      value={side.id}
      control={<Radio size="small" />}
      sx={{
        flex: 1,
        margin: 0,
        alignItems: 'flex-start',
        padding: '12px 14px',
        borderRadius: '8px',
        border: selected
          ? `2px solid ${tokens['action.primary']}`
          : `1px solid ${tokens['border.default']}`,
        backgroundColor: selected ? tokens['action.primary.tint'] : 'transparent',
      }}
      label={
        <Box sx={{ display: 'grid', gap: 1, paddingBlockStart: '2px' }}>
          <Typography variant="bodyStrong">{side.name}</Typography>
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            {side.accountName ?? t('contacts:details.noAccount')}
          </Typography>
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            {t('contacts:merge.tickets', { count: side.ticketCount })}
          </Typography>
        </Box>
      }
    />
  );
}

/** "Identities after the merge": the union, each identifier with its own state in words. */
function Identities({ preview }: { readonly preview: ContactMergePreview }): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();

  return (
    <Box
      sx={{
        display: 'grid',
        gap: 2,
        padding: '12px 14px',
        borderRadius: '8px',
        backgroundColor: tokens['bg.canvas'],
      }}
    >
      <Typography variant="body2" component="h3" sx={{ fontWeight: 500 }}>
        {t('contacts:merge.identities')}
      </Typography>
      <Box
        component="ul"
        sx={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 2 }}
      >
        {preview.identities.map((identity) => {
          const Icon = CHANNEL_ICONS[identity.kind];

          return (
            <Box
              key={identity.id}
              component="li"
              sx={{ display: 'flex', alignItems: 'center', gap: 3 }}
            >
              <Icon size={14} aria-hidden="true" color={tokens['text.secondary']} />
              <Typography variant="body2" sx={{ flexGrow: 1, minWidth: 0 }}>
                <bdi>{identityLabel(identity)}</bdi>
              </Typography>
              <Typography
                variant="caption"
                sx={{
                  color: identity.verified
                    ? tokens['status.success.text']
                    : tokens['status.warning.text'],
                }}
              >
                {identity.verified
                  ? t('contacts:identity.verified')
                  : t('contacts:identity.unverified')}
              </Typography>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
