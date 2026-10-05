import {
  WEBHOOK_DELIVERY_ATTEMPTS,
  type Webhook,
  type WebhookOverview,
  type WebhookWithSecret,
} from '@helpdock/schemas';
import { Box, Button, Typography } from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleAlert, Plus, Webhook as WebhookIcon } from 'lucide-react';
import { type ReactNode, useCallback, useId, useState } from 'react';
import { useT } from '../../../app/i18n.js';
import { usePreferences } from '../../../app/providers.tsx';
import { useSemanticTokens } from '../../../app/tokens.js';
import { currentBrand, useSession } from '../../../auth/session.tsx';
import { useDevelopersApi } from '../../../developers/context.tsx';
import { EmptyState } from '../../../shell/empty-state.tsx';
import { AlertBanner } from '../../../ui/alert-banner.tsx';
import { ConfirmDialog } from '../../../ui/confirm-dialog.tsx';
import { useToast } from '../../../ui/toasts.tsx';
import { Card, CardHeader } from './card.tsx';
import { DeliveryDetail } from './delivery-detail.tsx';
import { DeliveryLog, deliveriesKey, RetrySchedule } from './delivery-log.tsx';
import { EndpointFormDialog } from './endpoint-form-dialog.tsx';
import { EndpointPanel } from './endpoint-panel.tsx';
import { EndpointsTable } from './endpoints-table.tsx';
import { dayAndTime } from './format.js';
import { SecretReveal } from './secret-reveal.tsx';
import { TestEventBox } from './test-event.tsx';

/**
 * Developers › Webhooks (M8-03, `Admin/Developers-Webhooks`): a Banner for
 * each endpoint Helpdock turned off, the Endpoints table, the open endpoint
 * with its signing secret, and its DeliveryLog beside the delivery detail.
 *
 * Adding an endpoint shows its signing secret once, with a test event to
 * send; rotating does the same without the test. Both go through
 * SecretReveal, and neither secret is kept anywhere once "Done" is pressed.
 */

const queryKey = (brandId: string) => ['developers', 'webhooks', brandId] as const;

type Revealed =
  | { readonly kind: 'added'; readonly webhook: WebhookWithSecret }
  | { readonly kind: 'rotated'; readonly webhook: WebhookWithSecret };

type FormMode = { readonly kind: 'add' } | { readonly kind: 'edit'; readonly webhook: Webhook };

export function WebhooksTab({
  adding,
  onAdd,
  onAddClose,
}: {
  readonly adding: boolean;
  onAdd(): void;
  onAddClose(): void;
}): ReactNode {
  const t = useT();
  const api = useDevelopersApi();
  const brand = currentBrand(useSession());
  const toast = useToast();
  const queryClient = useQueryClient();
  const headingId = useId();
  const [openId, setOpenId] = useState<string | null>(null);
  const [deliveryId, setDeliveryId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Webhook | null>(null);
  const [revealed, setRevealed] = useState<Revealed | null>(null);
  const [rotating, setRotating] = useState<WebhookOverview | null>(null);
  const [deleting, setDeleting] = useState<WebhookOverview | null>(null);

  const webhooks = useQuery({
    queryKey: queryKey(brand.id),
    queryFn: () => api.webhooks(brand.id),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKey(brand.id) });
  const failed = () => {
    toast({ tone: 'danger', message: t('developers:failed') });
  };

  const rows = webhooks.data?.webhooks ?? [];
  const open = rows.find((row) => row.id === openId) ?? rows[0] ?? null;
  const turnedOff = rows.filter((row) => row.disabledReason === 'failures');

  const openEndpoint = (webhook: WebhookOverview): void => {
    setOpenId(webhook.id);
    setDeliveryId(null);
  };
  const selectDelivery = useCallback((id: string) => {
    setDeliveryId(id);
  }, []);

  const toggle = useMutation({
    mutationFn: (webhook: WebhookOverview) =>
      api.updateWebhook(brand.id, webhook.id, { enabled: !webhook.enabled }),
    onSuccess: async (webhook) => {
      await refresh();
      toast({
        tone: 'success',
        message: t(
          webhook.enabled
            ? 'developers:webhooks.toast.turnedOn'
            : 'developers:webhooks.toast.turnedOff',
          { url: webhook.url },
        ),
      });
    },
    onError: failed,
  });

  const test = useMutation({
    mutationFn: (webhook: WebhookOverview) => api.sendTestEvent(brand.id, webhook.id),
    onSuccess: async (delivery, webhook) => {
      setOpenId(webhook.id);
      setDeliveryId(delivery.id);
      await queryClient.invalidateQueries({ queryKey: deliveriesKey(brand.id, webhook.id) });
      toast({
        tone: 'success',
        message: t('developers:webhooks.test.queued', { url: webhook.url }),
      });
    },
    onError: failed,
  });

  const rotate = useMutation({
    mutationFn: (webhook: WebhookOverview) => api.rotateWebhookSecret(brand.id, webhook.id),
    onSuccess: async (webhook) => {
      setRotating(null);
      setRevealed({ kind: 'rotated', webhook });
      await refresh();
      toast({ tone: 'success', message: t('developers:webhooks.toast.rotated') });
    },
    onError: failed,
  });

  const remove = useMutation({
    mutationFn: (webhook: WebhookOverview) => api.removeWebhook(brand.id, webhook.id),
    onSuccess: async (_result, webhook) => {
      setDeleting(null);
      setOpenId(null);
      setDeliveryId(null);
      await refresh();
      toast({
        tone: 'success',
        message: t('developers:webhooks.toast.deleted', { url: webhook.url }),
      });
    },
    onError: failed,
  });

  const busy = toggle.isPending || test.isPending || rotate.isPending;
  const formMode: FormMode =
    editing === null ? { kind: 'add' } : { kind: 'edit', webhook: editing };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {webhooks.isError ? (
        <AlertBanner tone="danger">{t('developers:loadFailed')}</AlertBanner>
      ) : null}

      {turnedOff.map((webhook) => (
        <TurnedOffBanner
          key={webhook.id}
          webhook={webhook}
          busy={toggle.isPending}
          onOpenLog={() => {
            openEndpoint(webhook);
          }}
          onTurnOn={() => {
            toggle.mutate(webhook);
          }}
        />
      ))}

      {webhooks.isSuccess && rows.length === 0 ? (
        <EmptyState
          icon={WebhookIcon}
          heading={t('developers:webhooks.empty.heading')}
          body={t('developers:webhooks.empty.body')}
          action={
            <Button
              variant="contained"
              startIcon={<Plus size={16} aria-hidden="true" />}
              onClick={onAdd}
            >
              {t('developers:webhooks.add')}
            </Button>
          }
        />
      ) : null}

      {rows.length > 0 ? (
        <Card labelledBy={headingId}>
          <CardHeader
            headingId={headingId}
            heading={t('developers:webhooks.heading')}
            caption={t('developers:webhooks.summary', {
              endpoints: t('developers:webhooks.endpointCount', { count: rows.length }),
              attempts: WEBHOOK_DELIVERY_ATTEMPTS,
            })}
          />
          <EndpointsTable
            webhooks={rows}
            selectedId={open?.id ?? null}
            actions={{
              onOpen: openEndpoint,
              onTest: (webhook) => {
                test.mutate(webhook);
              },
              onEdit: (webhook) => {
                setEditing(webhook);
              },
              onToggle: (webhook) => {
                toggle.mutate(webhook);
              },
              onDelete: setDeleting,
            }}
          />
        </Card>
      ) : null}

      {open === null ? null : (
        <>
          <EndpointPanel
            webhook={open}
            busy={busy}
            onTest={() => {
              test.mutate(open);
            }}
            onEdit={() => {
              setEditing(open);
            }}
            onToggle={() => {
              toggle.mutate(open);
            }}
            onRotate={() => {
              setRotating(open);
            }}
          />
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: { xs: 'minmax(0, 1fr)', lg: 'minmax(0, 1fr) minmax(0, 1fr)' },
              gap: 6,
              alignItems: 'start',
            }}
          >
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
              <DeliveryLog
                key={open.id}
                webhook={open}
                selectedId={deliveryId}
                onSelect={selectDelivery}
              />
              <RetrySchedule />
            </Box>
            <DeliveryDetail
              webhookId={open.id}
              deliveryId={deliveryId}
              onReplayed={(delivery) => {
                setDeliveryId(delivery.id);
              }}
            />
          </Box>
        </>
      )}

      <EndpointFormDialog
        open={adding || editing !== null}
        mode={formMode}
        onClose={() => {
          setEditing(null);
          onAddClose();
        }}
        onAdded={(webhook) => {
          onAddClose();
          setOpenId(webhook.id);
          setDeliveryId(null);
          setRevealed({ kind: 'added', webhook });
          void refresh();
          toast({ tone: 'success', message: t('developers:webhooks.toast.added') });
        }}
        onSaved={() => {
          setEditing(null);
          void refresh();
          toast({ tone: 'success', message: t('developers:webhooks.toast.saved') });
        }}
      />

      <SecretReveal
        open={revealed !== null}
        title={t(
          revealed?.kind === 'rotated'
            ? 'developers:webhooks.rotated.title'
            : 'developers:webhooks.created.title',
        )}
        warningStrong={t(
          revealed?.kind === 'rotated'
            ? 'developers:webhooks.rotated.warningStrong'
            : 'developers:webhooks.created.warningStrong',
        )}
        warning={t(
          revealed?.kind === 'rotated'
            ? 'developers:webhooks.rotated.warning'
            : 'developers:webhooks.created.warning',
        )}
        label={t('developers:webhooks.created.secretLabel')}
        secret={revealed?.webhook.secret ?? ''}
        onDone={() => {
          if (revealed !== null) {
            void queryClient.invalidateQueries({
              queryKey: deliveriesKey(brand.id, revealed.webhook.id),
            });
          }
          setRevealed(null);
          void refresh();
        }}
      >
        {revealed?.kind === 'added' ? <TestEventBox webhookId={revealed.webhook.id} /> : undefined}
      </SecretReveal>

      <ConfirmDialog
        open={rotating !== null}
        title={t('developers:webhooks.rotateConfirm.title')}
        body={t('developers:webhooks.rotateConfirm.body')}
        confirmLabel={t('developers:webhooks.rotateConfirm.action')}
        busy={rotate.isPending}
        onConfirm={() => {
          if (rotating !== null) {
            rotate.mutate(rotating);
          }
        }}
        onClose={() => {
          setRotating(null);
        }}
      />

      <ConfirmDialog
        open={deleting !== null}
        title={t('developers:webhooks.deleteConfirm.title', { url: deleting?.url ?? '' })}
        body={t('developers:webhooks.deleteConfirm.body')}
        confirmLabel={t('developers:webhooks.deleteConfirm.action')}
        destructive
        busy={remove.isPending}
        onConfirm={() => {
          if (deleting !== null) {
            remove.mutate(deleting);
          }
        }}
        onClose={() => {
          setDeleting(null);
        }}
      />
    </Box>
  );
}

/**
 * The danger Banner of `Admin/Developers-Webhooks` for an endpoint Helpdock
 * switched off after failed deliveries: why, since when, and the two ways on.
 */
function TurnedOffBanner({
  webhook,
  busy,
  onOpenLog,
  onTurnOn,
}: {
  readonly webhook: WebhookOverview;
  readonly busy: boolean;
  onOpenLog(): void;
  onTurnOn(): void;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const { locale } = usePreferences();
  const last = webhook.lastDelivery;
  const answer =
    last === null || last.responseStatus === null
      ? t('developers:webhooks.banner.noAnswer')
      : String(last.responseStatus);
  const date = dayAndTime(last?.lastAttemptAt ?? webhook.updatedAt, locale);

  return (
    <Box
      role="alert"
      sx={{
        display: 'flex',
        gap: 3,
        alignItems: 'flex-start',
        padding: 3,
        borderRadius: '6px',
        backgroundColor: tokens['status.danger.tint'],
        border: `1px solid ${tokens['status.danger']}`,
        color: tokens['status.danger.text'],
        flexWrap: 'wrap',
      }}
    >
      <CircleAlert size={16} aria-hidden="true" style={{ flexShrink: 0, marginBlockStart: 2 }} />
      <Box sx={{ flex: '1 1 320px', minWidth: 0 }}>
        <Typography
          variant="body2"
          sx={{ fontWeight: 600, color: 'inherit', overflowWrap: 'anywhere' }}
        >
          {t('developers:webhooks.banner.title', { url: webhook.url })}
        </Typography>
        <Typography variant="body2" sx={{ color: 'inherit' }}>
          {t('developers:webhooks.banner.body', {
            n: webhook.consecutiveFailures,
            answer,
            date,
          })}
        </Typography>
      </Box>
      <Box sx={{ display: 'flex', gap: 2, flexShrink: 0 }}>
        <Button size="small" variant="outlined" color="inherit" onClick={onOpenLog}>
          {t('developers:webhooks.banner.openLog')}
        </Button>
        <Button size="small" variant="outlined" color="inherit" disabled={busy} onClick={onTurnOn}>
          {t('developers:webhooks.banner.turnOn')}
        </Button>
      </Box>
    </Box>
  );
}
