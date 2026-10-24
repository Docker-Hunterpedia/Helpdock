import type { NotificationPreferencesView } from '@helpdock/schemas';
import { Box, Link as MuiLink } from '@mui/material';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Info, TriangleAlert } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useT } from '../app/i18n.js';
import { usePreferences } from '../app/providers.tsx';
import { useSemanticTokens } from '../app/tokens.js';
import { useToast } from '../ui/toasts.tsx';
import { useNotificationsApi } from './context.tsx';
import { dayLabel, type EmailStatusKind, emailStatuses, whenLabel } from './email-status.js';
import { PREFERENCES_KEY } from './use-preferences.js';

/**
 * The status line of `Admin/Account-Notifications-Schedule` (M14-11): one
 * `role="status"` strip that says what is stopping email and offers the way
 * back, at the top of the Email schedule card and, for the most lasting reason,
 * at the head of the bell's panel.
 *
 * Paused is a warning (it ends by itself, and push stops with it); an
 * unsubscribe, Off and an install that cannot send are neutral notes. The icon
 * carries the tone as well as the colour (DESIGN §10).
 */

export function EmailStatusLines({
  view,
  only,
}: {
  readonly view: NotificationPreferencesView;
  /**
   * The bell shows the first reason alone, and never the install's own lack of
   * outgoing email: that is the Notifications tab's to say, not every panel's.
   */
  readonly only?: 'first';
}): ReactNode {
  const [now] = useState(() => Date.now());
  const all = emailStatuses(view, now);
  const kinds = only === 'first' ? all.filter((kind) => kind !== 'notConfigured') : all;

  if (kinds.length === 0) {
    return null;
  }

  return (
    <>
      {(only === 'first' ? kinds.slice(0, 1) : kinds).map((kind) => (
        <EmailStatusLine key={kind} kind={kind} view={view} now={now} />
      ))}
    </>
  );
}

function EmailStatusLine({
  kind,
  view,
  now,
}: {
  readonly kind: EmailStatusKind;
  readonly view: NotificationPreferencesView;
  readonly now: number;
}): ReactNode {
  const t = useT();
  const api = useNotificationsApi();
  const tokens = useSemanticTokens();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { locale } = usePreferences();
  const { emailDelivery } = view;

  const change = useMutation({
    mutationFn: (update: Parameters<typeof api.updateSettings>[0]) => api.updateSettings(update),
    onSuccess: (saved, update) => {
      queryClient.setQueryData(PREFERENCES_KEY, saved);
      toast({
        tone: 'success',
        message:
          update.emailUnsubscribed === false
            ? t('me:notifications.schedule.toast.emailBack')
            : t('me:notifications.schedule.toast.resumed'),
      });
    },
    onError: () => {
      toast({ tone: 'danger', message: t('me:notifications.schedule.toast.failed') });
    },
  });

  const lines: Record<
    EmailStatusKind,
    () => { text: string; action?: { label: string; run(): void } }
  > = {
    paused: () => ({
      text: t('me:notifications.schedule.status.paused', {
        when: whenLabel(
          emailDelivery.pausedUntil ?? '',
          locale,
          now,
          view.digestTimeZone ?? undefined,
        ),
      }),
      action: {
        label: t('me:notifications.schedule.status.resume'),
        run: () => {
          change.mutate({ pausedUntil: null });
        },
      },
    }),
    unsubscribed: () => ({
      text: t('me:notifications.schedule.status.unsubscribed', {
        date: dayLabel(emailDelivery.unsubscribedAt ?? '', locale),
      }),
      action: {
        label: t('me:notifications.schedule.status.turnOn'),
        run: () => {
          change.mutate({ emailUnsubscribed: false });
        },
      },
    }),
    off: () => ({ text: t('me:notifications.schedule.status.off') }),
    notConfigured: () => ({ text: t('me:notifications.schedule.status.notConfigured') }),
  };
  const line = lines[kind]();
  const warning = kind === 'paused';
  const Icon = warning ? TriangleAlert : Info;

  return (
    <Box
      role="status"
      sx={{
        display: 'flex',
        gap: 2.5,
        padding: 3,
        borderRadius: '6px',
        fontSize: 13,
        lineHeight: '20px',
        backgroundColor: warning ? tokens['status.warning.tint'] : tokens['bg.muted'],
        color: warning ? tokens['status.warning.text'] : tokens['text.primary'],
      }}
    >
      <Icon size={16} aria-hidden="true" style={{ flexShrink: 0, marginBlockStart: 2 }} />
      <span>
        {line.text}
        {line.action === undefined ? null : (
          <>
            {' '}
            <MuiLink
              component="button"
              type="button"
              disabled={change.isPending}
              onClick={line.action.run}
              sx={{
                font: 'inherit',
                color: 'inherit',
                textDecoration: 'underline',
                verticalAlign: 'baseline',
                cursor: 'pointer',
              }}
            >
              {line.action.label}
            </MuiLink>
          </>
        )}
      </span>
    </Box>
  );
}
