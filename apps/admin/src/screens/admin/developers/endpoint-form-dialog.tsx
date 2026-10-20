import type { Webhook, WebhookEvent, WebhookWithSecret } from '@helpdock/schemas';
import {
  Box,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  IconButton,
  TextField,
  Typography,
} from '@mui/material';
import { useMutation } from '@tanstack/react-query';
import { CircleAlert, X } from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useId, useState } from 'react';
import { useT } from '../../../app/i18n.js';
import { useSemanticTokens } from '../../../app/tokens.js';
import { currentBrand, useSession } from '../../../auth/session.tsx';
import { isWebhooksError } from '../../../developers/api.js';
import { useDevelopersApi } from '../../../developers/context.tsx';
import { fieldDescribedBy } from '../../../ui/field.tsx';
import { useToast } from '../../../ui/toasts.tsx';
import { CheckList } from './check-list.tsx';

/**
 * "Add endpoint" and "Edit endpoint" (`Admin/Developers-Webhooks` panels 1 and
 * 3): the URL and the events. The browser checks only that the URL is an
 * `https://` one; whether its name resolves to a private address is the api's
 * check, and its refusal is drawn under the field with the address it found.
 */

type Mode = { readonly kind: 'add' } | { readonly kind: 'edit'; readonly webhook: Webhook };

const looksLikeUrl = (value: string): boolean => {
  const url = URL.parse(value.trim());
  return url !== null && (url.protocol === 'https:' || url.protocol === 'http:');
};

export function EndpointFormDialog({
  open,
  mode,
  onClose,
  onAdded,
  onSaved,
}: {
  readonly open: boolean;
  readonly mode: Mode;
  onClose(): void;
  onAdded(webhook: WebhookWithSecret): void;
  onSaved(webhook: Webhook): void;
}): ReactNode {
  const t = useT();
  const api = useDevelopersApi();
  const brand = currentBrand(useSession());
  const toast = useToast();
  const tokens = useSemanticTokens();
  const titleId = useId();
  const urlId = useId();
  const editing = mode.kind === 'edit' ? mode.webhook : null;
  const [includeInternalNotes, setIncludeInternalNotes] = useState(false);
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<readonly WebhookEvent[]>([]);
  const [urlError, setUrlError] = useState<string | undefined>(undefined);
  const [eventsError, setEventsError] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (open) {
      setUrl(editing?.url ?? '');
      setIncludeInternalNotes(editing?.includeInternalNotes ?? false);
      setEvents(editing?.events ?? []);
      setUrlError(undefined);
      setEventsError(undefined);
    }
  }, [open, editing]);

  const save = useMutation({
    mutationFn: async () => {
      const request = { url: url.trim(), events: [...events], includeInternalNotes };
      return editing === null
        ? { added: await api.createWebhook(brand.id, request) }
        : { saved: await api.updateWebhook(brand.id, editing.id, request) };
    },
    onSuccess: (result) => {
      if ('added' in result) {
        onAdded(result.added);
      } else {
        onSaved(result.saved);
      }
    },
    onError: (failure) => {
      if (isWebhooksError(failure)) {
        setUrlError(
          failure.reason === 'webhook-destination-blocked' && failure.address === undefined
            ? t('developers:webhooks.refusals.webhook-destination-blocked-unknown')
            : t(`developers:webhooks.refusals.${failure.reason}`, {
                address: failure.address ?? '',
              }),
        );
        return;
      }
      toast({ tone: 'danger', message: t('developers:failed') });
    },
  });

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const badUrl = looksLikeUrl(url) ? undefined : t('developers:webhooks.form.urlInvalid');
    const noEvents = events.length === 0 ? t('developers:webhooks.form.eventsRequired') : undefined;
    setUrlError(badUrl);
    setEventsError(noEvents);
    if (badUrl === undefined && noEvents === undefined) {
      save.mutate();
    }
  };

  const close = (): void => {
    if (!save.isPending) {
      onClose();
    }
  };

  const hint = t('developers:webhooks.form.urlHint');

  return (
    <Dialog
      open={open}
      onClose={close}
      aria-labelledby={titleId}
      maxWidth="xs"
      fullWidth
      slotProps={{ paper: { sx: { maxWidth: 520, borderRadius: '10px' } } }}
    >
      <Box
        component="form"
        noValidate
        onSubmit={submit}
        sx={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}
      >
        <DialogTitle
          id={titleId}
          sx={{
            fontSize: 16,
            fontWeight: 600,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          {t(
            editing === null
              ? 'developers:webhooks.form.addTitle'
              : 'developers:webhooks.form.editTitle',
          )}
          <IconButton size="small" aria-label={t('developers:webhooks.form.close')} onClick={close}>
            <X size={16} aria-hidden="true" />
          </IconButton>
        </DialogTitle>
        <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <Box sx={{ display: 'flex', flexDirection: 'column' }}>
            <Typography
              component="label"
              htmlFor={urlId}
              sx={{ fontSize: 13, fontWeight: 500, lineHeight: '20px', marginBlockEnd: '6px' }}
            >
              {t('developers:webhooks.form.url')}
            </Typography>
            <TextField
              id={urlId}
              size="small"
              value={url}
              error={urlError !== undefined}
              placeholder="https://"
              onChange={(event) => {
                setUrl(event.target.value);
                setUrlError(undefined);
              }}
              slotProps={{
                htmlInput: {
                  dir: 'ltr',
                  inputMode: 'url',
                  spellCheck: false,
                  autoCapitalize: 'none',
                  maxLength: 2000,
                  'aria-invalid': urlError !== undefined,
                  'aria-describedby': fieldDescribedBy(urlId, { hint, error: urlError }),
                  style: { fontFamily: 'var(--hd-font-mono, monospace)', fontSize: 13 },
                },
              }}
            />
            {urlError === undefined ? (
              <Typography
                id={`${urlId}-hint`}
                variant="caption"
                sx={{ marginBlockStart: '6px', color: 'text.secondary' }}
              >
                {hint}
              </Typography>
            ) : (
              <Typography
                id={`${urlId}-error`}
                variant="caption"
                sx={{
                  marginBlockStart: '6px',
                  color: tokens['status.danger.text'],
                  display: 'flex',
                  gap: 1,
                  alignItems: 'flex-start',
                }}
              >
                <CircleAlert
                  size={14}
                  aria-hidden="true"
                  style={{ flexShrink: 0, marginBlockStart: 1 }}
                />
                {urlError}
              </Typography>
            )}
          </Box>

          <Box
            component="fieldset"
            sx={{
              border: 0,
              padding: 0,
              margin: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: 3,
            }}
          >
            <Typography component="legend" sx={{ fontSize: 14, fontWeight: 600 }}>
              {t('developers:webhooks.form.events')}
            </Typography>
            {EVENT_GROUPS.map(({ key, events: group }) => (
              <CheckList<WebhookEvent>
                key={key}
                legend={t(`developers:webhooks.groups.${key}`)}
                options={group.map((event) => ({
                  value: event,
                  hint: t(`developers:webhooks.eventHints.${event}`),
                  badge: NEW_EVENTS.has(event) ? t('developers:webhooks.newEvent') : undefined,
                }))}
                selected={events}
                onChange={(next) => {
                  setEvents([
                    ...events.filter((event) => !group.includes(event)),
                    ...next.filter((event) => group.includes(event)),
                  ]);
                  setEventsError(undefined);
                }}
              />
            ))}
            {eventsError === undefined ? null : (
              <Typography
                role="alert"
                variant="caption"
                sx={{ color: tokens['status.danger.text'] }}
              >
                {eventsError}
              </Typography>
            )}
            <FormControlLabel
              control={
                <Checkbox
                  checked={includeInternalNotes}
                  onChange={(event) => setIncludeInternalNotes(event.target.checked)}
                />
              }
              label={
                <Box>
                  <Typography variant="body2">
                    {t('developers:webhooks.includeInternalNotes')}
                  </Typography>
                  <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                    {t('developers:webhooks.notesHint')}
                  </Typography>
                </Box>
              }
            />
          </Box>

          {editing === null ? (
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              {t('developers:webhooks.form.secretNote')}
            </Typography>
          ) : null}
        </DialogContent>
        <DialogActions sx={{ padding: 4, gap: 2 }}>
          <Button variant="text" onClick={close} disabled={save.isPending}>
            {t('common:actions.cancel')}
          </Button>
          <Button type="submit" variant="contained" disabled={save.isPending}>
            {t(editing === null ? 'developers:webhooks.add' : 'developers:webhooks.form.save')}
          </Button>
        </DialogActions>
      </Box>
    </Dialog>
  );
}

const EVENT_GROUPS: readonly {
  key: 'tickets' | 'messages' | 'contacts' | 'other';
  events: readonly WebhookEvent[];
}[] = [
  {
    key: 'tickets',
    events: [
      'ticket.created',
      'ticket.updated',
      'ticket.assigned',
      'ticket.status_changed',
      'ticket.merged',
      'ticket.closed',
    ],
  },
  { key: 'messages', events: ['ticket.replied', 'message.created'] },
  {
    key: 'contacts',
    events: [
      'contact.created',
      'contact.updated',
      'contact.merged',
      'account.created',
      'account.updated',
    ],
  },
  { key: 'other', events: ['csat.received', 'article.published'] },
];
const NEW_EVENTS = new Set<WebhookEvent>([
  'ticket.assigned',
  'ticket.status_changed',
  'ticket.merged',
  'message.created',
  'contact.updated',
  'contact.merged',
  'account.created',
  'account.updated',
]);
