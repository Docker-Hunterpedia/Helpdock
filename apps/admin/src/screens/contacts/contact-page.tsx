import type {
  ContactDetail,
  ContactDuplicateSuggestion,
  ContactIdentityInput,
  ContactMergeSummary,
} from '@helpdock/schemas';
import {
  Box,
  Button,
  Chip,
  Link as MuiLink,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock, Trash2 } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router';
import { useT } from '../../app/i18n.js';
import { accountRoute, contactRoute, ROUTES } from '../../app/route-paths.js';
import { useSemanticTokens } from '../../app/tokens.js';
import { currentBrand, useContactsApi, useSession } from '../../auth/session.tsx';
import { ConfirmDialog } from '../../ui/confirm-dialog.tsx';
import { useToast } from '../../ui/toasts.tsx';
import { ContactDialog, IdentityDialog } from './contact-dialogs.tsx';
import { DuplicateSuggestions } from './duplicate-suggestions.tsx';
import { csatLabel, DASH, durationLabel, identityLabel } from './format.js';
import { ContactAvatar, IdentityLine } from './identity-pieces.tsx';
import { MergeBanners } from './merge-banner.tsx';
import { MergeContactsDialog } from './merge-contacts-dialog.tsx';
import { useContactAction } from './use-contact-action.js';

/**
 * `Admin/Contact`: one person, everything known about them, and the history the
 * viewer is allowed to see.
 *
 * **The lock rows are the point.** DOMAIN-RULES §1.2 says the timeline shows a
 * count of the tickets a viewer's departments exclude, so the agent knows
 * history exists without learning anything about it. That count drives both the
 * caption under the heading and the inline row in the list, and it is the only
 * thing this screen says about those tickets.
 *
 * **Merging is M1-13's.** A duplicate suggestion opens the merge dialog; the
 * toast that confirms a merge carries an Undo, and the banner on the surviving
 * contact keeps one for the 24 hours DOMAIN-RULES §4.4 allows. A contact that
 * was merged away sends the viewer on to the one it was merged into.
 */
export function ContactPage(): ReactNode {
  const t = useT();
  const session = useSession();
  const api = useContactsApi();
  const tokens = useSemanticTokens();
  const queryClient = useQueryClient();
  const noteId = useId();
  const { contactId = '' } = useParams();

  const brand = currentBrand(session);
  const [filter, setFilter] = useState<'all' | 'open' | 'notes'>('all');
  const [editing, setEditing] = useState(false);
  const [addingIdentity, setAddingIdentity] = useState(false);
  const [erasing, setErasing] = useState(false);
  const [note, setNote] = useState('');
  const [merging, setMerging] = useState<ContactDuplicateSuggestion | null>(null);
  const toast = useToast();
  const navigate = useNavigate();

  const contact = useQuery({
    queryKey: ['contact', brand.id, contactId],
    queryFn: () => api.contact(brand.id, contactId),
  });

  const timeline = useQuery({
    queryKey: ['contact-timeline', brand.id, contactId],
    queryFn: () => api.timeline(brand.id, contactId),
  });

  const accounts = useQuery({
    queryKey: ['accounts', brand.id, ''],
    queryFn: () => api.listAccounts(brand.id),
  });

  const refresh = async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['contact', brand.id, contactId] }),
      queryClient.invalidateQueries({ queryKey: ['contact-timeline', brand.id, contactId] }),
      queryClient.invalidateQueries({ queryKey: ['contacts', brand.id] }),
    ]);
  };

  const save = useContactAction(
    (value: Parameters<typeof api.updateContact>[2]) =>
      api.updateContact(brand.id, contactId, value),
    (_value, result: ContactDetail) => t('contacts:toast.updated', { name: result.name }),
    refresh,
  );

  const addNote = useContactAction(
    (bodyText: string) => api.addNote(brand.id, contactId, { bodyText }),
    () => t('contacts:toast.noteAdded'),
    refresh,
  );

  const addIdentity = useContactAction(
    (value: ContactIdentityInput) => api.addIdentity(brand.id, contactId, value),
    () => t('contacts:toast.identityAdded'),
    refresh,
  );

  const removeIdentity = useContactAction(
    (identityId: string) => api.removeIdentity(brand.id, contactId, identityId),
    () => t('contacts:toast.identityRemoved'),
    refresh,
  );

  const dismissDuplicate = useContactAction(
    (suggestionId: string) => api.dismissDuplicate(brand.id, contactId, suggestionId),
    () => t('contacts:toast.duplicateDismissed'),
    refresh,
  );

  const undoMerge = useContactAction(
    (merge: { readonly survivorId: string; readonly summary: ContactMergeSummary }) =>
      api.undoMerge(brand.id, merge.survivorId, merge.summary.id),
    ({ summary }) => t('contacts:merge.undone', { name: summary.mergedContact.name }),
    refresh,
  );

  const merge = useContactAction(
    (choice: { survivorId: string; mergedId: string; suggestionId: string | undefined }) =>
      api.mergeContacts(brand.id, choice.survivorId, {
        mergedContactId: choice.mergedId,
        ...(choice.suggestionId === undefined ? {} : { suggestionId: choice.suggestionId }),
      }),
    () => '',
    async (survivor: ContactDetail, choice) => {
      setMerging(null);
      await refresh();
      const summary = survivor.merges.find((row) => row.mergedContact.id === choice.mergedId);
      if (survivor.id !== contactId) {
        await navigate(contactRoute(survivor.id));
      }
      toast({
        tone: 'success',
        message: t('contacts:merge.toast', {
          merged: summary?.mergedContact.name ?? '',
          survivor: survivor.name,
        }),
        ...(summary === undefined
          ? {}
          : {
              action: {
                label: t('contacts:merge.undo'),
                onClick: () => {
                  undoMerge.mutate({ survivorId: survivor.id, summary });
                },
              },
            }),
      });
    },
    { silent: true },
  );

  const anonymise = useContactAction(
    () => api.anonymise(brand.id, contactId),
    (_input, result: ContactDetail) => t('contacts:toast.anonymised', { name: result.name }),
    refresh,
  );

  const detail = contact.data;
  if (detail === undefined) {
    return null;
  }
  if (detail.mergedIntoId !== null) {
    return <Navigate to={contactRoute(detail.mergedIntoId)} replace />;
  }

  const hiddenCount = timeline.data?.hiddenCount ?? 0;
  const items = timeline.data?.items ?? [];
  const notes = detail.notes;
  const visibleItems = filter === 'notes' ? [] : items;
  const visibleNotes = filter === 'open' ? [] : notes;

  return (
    <>
      <Box sx={{ marginBlockEnd: 6 }}>
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          <MuiLink component={Link} to={ROUTES.contacts}>
            {t('contacts:detail.breadcrumb')}
          </MuiLink>
          {' / '}
        </Typography>
        <Box
          sx={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 6,
            marginBlockStart: 1,
          }}
        >
          <Box sx={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <ContactAvatar name={detail.name} size={40} anonymous={detail.anonymised} />
            <Box>
              <Typography variant="h1" component="h1">
                {detail.name}
              </Typography>
              <Typography
                variant="caption"
                component="p"
                sx={{ color: 'text.secondary', marginBlockStart: 1 }}
              >
                {[
                  detail.account?.name,
                  ...detail.identities.map((identity) =>
                    `${identityLabel(identity)} ${
                      identity.kind === 'visitor'
                        ? t('contacts:identity.linked')
                        : identity.verified
                          ? t('contacts:identity.verified')
                          : t('contacts:identity.unverified')
                    }`.trim(),
                  ),
                ]
                  .filter((part): part is string => part !== undefined && part !== '')
                  .join(' · ')}
              </Typography>
              {typeof detail.custom.tag === 'string' ? (
                <Chip size="small" label={detail.custom.tag} sx={{ marginBlockStart: 2 }} />
              ) : null}
            </Box>
          </Box>

          <Box sx={{ display: 'flex', gap: 2 }}>
            <Button
              variant="outlined"
              disabled={detail.anonymised}
              onClick={() => {
                setEditing(true);
              }}
            >
              {t('contacts:detail.edit')}
            </Button>
            <Button
              variant="outlined"
              color="error"
              disabled={detail.anonymised}
              startIcon={<Trash2 size={16} aria-hidden="true" />}
              onClick={() => {
                setErasing(true);
              }}
            >
              {t('contacts:actions.anonymise')}
            </Button>
          </Box>
        </Box>

        <MergeBanners
          merges={detail.merges}
          busy={undoMerge.isPending}
          now={Date.now()}
          onUndo={(summary) => {
            undoMerge.mutate({ survivorId: detail.id, summary });
          }}
        />

        {detail.anonymised ? (
          <Typography
            role="status"
            variant="caption"
            sx={{ display: 'block', color: tokens['status.warning.text'], marginBlockStart: 3 }}
          >
            {t('contacts:detail.erased')}
          </Typography>
        ) : null}
      </Box>

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 320px' }, gap: 6 }}>
        <Box>
          <Typography variant="h3" component="h2">
            {t('contacts:detail.timeline')}
          </Typography>
          <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary' }}>
            {t('contacts:detail.visibleTickets', { count: items.length })}
          </Typography>
          {hiddenCount > 0 ? (
            <Typography
              variant="caption"
              sx={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 1,
                color: tokens['status.warning.text'],
              }}
            >
              <Lock size={14} aria-hidden="true" />
              {t('contacts:detail.hidden', { count: hiddenCount })}
            </Typography>
          ) : null}

          <ToggleButtonGroup
            exclusive
            size="small"
            value={filter}
            aria-label={t('contacts:detail.timelineSegment')}
            sx={{ marginBlock: 4 }}
            onChange={(_event, next: 'all' | 'open' | 'notes' | null) => {
              if (next !== null) {
                setFilter(next);
              }
            }}
          >
            <ToggleButton value="all">{t('contacts:detail.all')}</ToggleButton>
            <ToggleButton value="open">{t('contacts:detail.open')}</ToggleButton>
            <ToggleButton value="notes">{t('contacts:detail.notes')}</ToggleButton>
          </ToggleButtonGroup>

          <Box
            component="ol"
            sx={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 3 }}
          >
            {visibleItems.map((item) => (
              <Box
                key={item.id}
                component="li"
                sx={{
                  border: `1px solid ${tokens['border.default']}`,
                  borderRadius: '10px',
                  padding: 4,
                  backgroundColor: tokens['bg.surface'],
                }}
              >
                <Typography variant="bodyStrong" component="p">
                  {item.subject}
                </Typography>
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                  <bdi>{item.reference}</bdi>
                  {` · ${item.channel} · ${item.departmentName ?? DASH} · ${item.assigneeName ?? DASH}`}
                </Typography>
              </Box>
            ))}

            {visibleNotes.map((entry) => (
              <Box
                key={entry.id}
                component="li"
                sx={{
                  border: `1px dashed ${tokens['status.warning']}`,
                  borderRadius: '10px',
                  padding: 4,
                  backgroundColor: tokens['status.warning.tint'],
                }}
              >
                <Typography
                  variant="caption"
                  sx={{ display: 'block', color: tokens['status.warning.text'] }}
                >
                  {t('contacts:detail.note')}
                </Typography>
                <Typography variant="body2" component="p">
                  {entry.bodyText}
                </Typography>
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                  {t('contacts:detail.noteBy', {
                    author: entry.authorName,
                    date: new Date(entry.createdAt).toLocaleDateString(),
                  })}
                </Typography>
              </Box>
            ))}

            {hiddenCount > 0 ? (
              <Box
                component="li"
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 2,
                  border: `1px solid ${tokens['border.default']}`,
                  borderRadius: '10px',
                  padding: 4,
                  color: 'text.secondary',
                }}
              >
                <Lock size={14} aria-hidden="true" />
                <Typography variant="caption">
                  {t('contacts:detail.hiddenRow', { count: hiddenCount })}
                </Typography>
              </Box>
            ) : null}
          </Box>

          {visibleItems.length === 0 && visibleNotes.length === 0 && hiddenCount === 0 ? (
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>
              {t('contacts:detail.noTicketsBody')}
            </Typography>
          ) : null}

          <Box
            component="form"
            sx={{ display: 'flex', gap: 2, marginBlockStart: 5 }}
            onSubmit={(event) => {
              event.preventDefault();
              const body = note.trim();
              if (body !== '') {
                setNote('');
                addNote.mutate(body);
              }
            }}
          >
            <TextField
              id={noteId}
              size="small"
              fullWidth
              value={note}
              disabled={detail.anonymised}
              label={t('contacts:detail.addNote')}
              placeholder={t('contacts:detail.notePlaceholder')}
              onChange={(event) => {
                setNote(event.target.value);
              }}
            />
            <Button
              type="submit"
              variant="contained"
              disabled={detail.anonymised || note.trim() === '' || addNote.isPending}
            >
              {t('contacts:detail.saveNote')}
            </Button>
          </Box>
        </Box>

        <Box sx={{ display: 'grid', gap: 4, alignContent: 'start' }}>
          <Card title={t('contacts:identities.title')}>
            {detail.identities.map((identity) => (
              <Box
                key={identity.id}
                sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
              >
                <IdentityLine identity={identity} component="div" />
                <Button
                  size="small"
                  variant="text"
                  disabled={detail.anonymised || detail.identities.length <= 1}
                  aria-label={t('contacts:identity.remove', {
                    value: identityLabel(identity),
                  })}
                  onClick={() => {
                    removeIdentity.mutate(identity.id);
                  }}
                >
                  {t('contacts:confirm.removeIdentitySubmit')}
                </Button>
              </Box>
            ))}

            <Button
              size="small"
              variant="outlined"
              disabled={detail.anonymised}
              onClick={() => {
                setAddingIdentity(true);
              }}
            >
              {t('contacts:identity.add')}
            </Button>

            {detail.duplicates.length === 1 ? (
              <Box>
                <Typography variant="caption" sx={{ color: tokens['status.warning.text'] }}>
                  {t('contacts:duplicates.one', { name: detail.duplicates[0]?.other.name ?? '' })}
                </Typography>
                <DuplicateSuggestions
                  duplicates={detail.duplicates}
                  disabled={detail.anonymised}
                  onMerge={setMerging}
                  onDismiss={(duplicate) => {
                    dismissDuplicate.mutate(duplicate.id);
                  }}
                />
              </Box>
            ) : null}
          </Card>

          {detail.duplicates.length > 1 ? (
            <Card title={t('contacts:duplicates.title')}>
              <DuplicateSuggestions
                duplicates={detail.duplicates}
                disabled={detail.anonymised}
                onMerge={setMerging}
                onDismiss={(duplicate) => {
                  dismissDuplicate.mutate(duplicate.id);
                }}
              />
            </Card>
          ) : null}

          <Card title={t('contacts:details.title')}>
            <Detail label={t('contacts:details.account')}>
              {detail.account === null ? (
                DASH
              ) : (
                <MuiLink component={Link} to={accountRoute(detail.account.id)}>
                  {detail.account.name}
                </MuiLink>
              )}
            </Detail>
            <Detail label={t('contacts:details.language')}>{detail.locale ?? DASH}</Detail>
            <Detail label={t('contacts:details.timezone')}>{detail.timezone ?? DASH}</Detail>
            <Detail label={t('contacts:details.customerId')}>
              <Typography variant="mono">
                <bdi>{detail.externalId ?? DASH}</bdi>
              </Typography>
            </Detail>
            <Button
              size="small"
              variant="text"
              disabled={detail.anonymised}
              onClick={() => {
                setEditing(true);
              }}
            >
              {t('contacts:details.edit')}
            </Button>
          </Card>

          <Card title={t('contacts:stats.title')}>
            <Box sx={{ display: 'flex', gap: 4 }}>
              <Stat label={t('contacts:stats.tickets')} value={String(detail.stats.totalTickets)} />
              <Stat label={t('contacts:stats.csat')} value={csatLabel(detail.stats.csat)} />
              <Stat
                label={t('contacts:stats.firstReply')}
                value={durationLabel(detail.stats.averageFirstReplySeconds)}
              />
            </Box>
          </Card>
        </Box>
      </Box>

      <ContactDialog
        open={editing}
        contact={detail}
        accounts={accounts.data?.accounts ?? []}
        busy={save.isPending}
        onClose={() => {
          setEditing(false);
        }}
        onSubmit={(value) => {
          setEditing(false);
          save.mutate({
            name: value.name,
            accountId: value.accountId,
            locale: value.locale,
            timezone: value.timezone,
            externalId: value.externalId,
          });
        }}
      />

      <IdentityDialog
        open={addingIdentity}
        busy={addIdentity.isPending}
        onClose={() => {
          setAddingIdentity(false);
        }}
        onSubmit={(value) => {
          setAddingIdentity(false);
          addIdentity.mutate(value);
        }}
      />

      <MergeContactsDialog
        open={merging !== null}
        contactId={detail.id}
        otherContactId={merging?.other.id ?? detail.id}
        reason={merging === null ? null : t(`contacts:duplicates.reason.${merging.reason}`)}
        busy={merge.isPending}
        onClose={() => {
          setMerging(null);
        }}
        onMerge={({ survivor, merged }) => {
          merge.mutate({
            survivorId: survivor.id,
            mergedId: merged.id,
            suggestionId: merging?.id,
          });
        }}
      />

      <ConfirmDialog
        open={erasing}
        destructive
        busy={anonymise.isPending}
        title={t('contacts:confirm.anonymiseTitle', { name: detail.name })}
        body={t('contacts:confirm.anonymiseBody')}
        confirmLabel={t('contacts:confirm.anonymiseSubmit')}
        onClose={() => {
          setErasing(false);
        }}
        onConfirm={() => {
          setErasing(false);
          anonymise.mutate(undefined);
        }}
      />
    </>
  );
}

/** DESIGN §6.3 DetailsPanel: a surface card with a heading and labelled rows. */
function Card({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  const tokens = useSemanticTokens();

  return (
    <Box
      component="section"
      aria-label={title}
      sx={{
        display: 'grid',
        gap: 3,
        padding: 5,
        borderRadius: '10px',
        border: `1px solid ${tokens['border.default']}`,
        backgroundColor: tokens['bg.surface'],
      }}
    >
      <Typography variant="h3" component="h2">
        {title}
      </Typography>
      {children}
    </Box>
  );
}

function Detail({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 3 }}>
      <Typography variant="caption" sx={{ color: 'text.secondary' }}>
        {label}
      </Typography>
      <Typography variant="body2" component="div">
        {children}
      </Typography>
    </Box>
  );
}

function Stat({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <Box>
      <Typography variant="mono" component="p">
        {value}
      </Typography>
      <Typography variant="caption" sx={{ color: 'text.secondary' }}>
        {label}
      </Typography>
    </Box>
  );
}
