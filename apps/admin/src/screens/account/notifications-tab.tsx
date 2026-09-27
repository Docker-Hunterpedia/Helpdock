import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_KINDS,
  type NotificationChannel,
  type NotificationKind,
  type NotificationPreferences,
  type NotificationPreferencesView,
} from '@helpdock/schemas';
import {
  Box,
  Button,
  Checkbox,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock, Monitor, TriangleAlert } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useT } from '../../app/i18n.js';
import { usePreferences } from '../../app/providers.tsx';
import { useSemanticTokens } from '../../app/tokens.js';
import { currentBrand, useSession } from '../../auth/session.tsx';
import { PushDeniedError, type PushPermission } from '../../notifications/browser-push.js';
import { useBrowserPush, useNotificationsApi } from '../../notifications/context.tsx';
import { AlertBanner } from '../../ui/alert-banner.tsx';
import { useToast } from '../../ui/toasts.tsx';

/**
 * The Notifications tab of Your account (M3-07, artboard `AdminNotifications`
 * panel 2): which of the six events reach this person through which of the
 * three channels, and whether this browser receives push.
 *
 * The matrix is a table of checkboxes, each named "event, channel" so a screen
 * reader says what it toggles; nothing is saved until Save, and Discard puts the
 * saved state back. The push column is disabled while the install has no VAPID
 * keys, and the card beside it says why (ADR 0002).
 */

export const PREFERENCES_KEY = ['me', 'notification-preferences'] as const;

/**
 * Which of this browser's subscriptions the api knows it by. Per browser, so
 * the key is in this browser's storage; the id is not a secret.
 */
export const PUSH_SUBSCRIPTION_STORAGE = 'helpdock.push.subscriptionId';

const readStoredId = (): string | null => {
  try {
    return window.localStorage.getItem(PUSH_SUBSCRIPTION_STORAGE);
  } catch {
    return null;
  }
};

const storeId = (id: string | null): void => {
  try {
    if (id === null) {
      window.localStorage.removeItem(PUSH_SUBSCRIPTION_STORAGE);
    } else {
      window.localStorage.setItem(PUSH_SUBSCRIPTION_STORAGE, id);
    }
  } catch {
    // A browser that refuses storage still gets push; it just forgets which
    // row is its own and offers "Turn on" again next time.
  }
};

export function NotificationsTab(): ReactNode {
  const t = useT();
  const api = useNotificationsApi();
  const view = useQuery({ queryKey: PREFERENCES_KEY, queryFn: () => api.preferences() });

  if (view.isError) {
    return <AlertBanner tone="danger">{t('me:notifications.loadFailed')}</AlertBanner>;
  }
  if (view.data === undefined) {
    return null;
  }

  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: { xs: 'minmax(0, 1fr)', lg: 'minmax(0, 760px) 340px' },
        gap: 8,
        alignItems: 'start',
      }}
    >
      <PreferencesForm view={view.data} />
      <PushCard view={view.data} />
    </Box>
  );
}

function PreferencesForm({ view }: { readonly view: NotificationPreferencesView }): ReactNode {
  const t = useT();
  const api = useNotificationsApi();
  const tokens = useSemanticTokens();
  const toast = useToast();
  const queryClient = useQueryClient();
  const session = useSession();
  const [draft, setDraft] = useState<NotificationPreferences | null>(null);
  const shown = draft ?? view.preferences;
  const firstName = session.user.name.trim().split(/\s+/)[0] ?? session.user.name;

  const save = useMutation({
    mutationFn: (preferences: NotificationPreferences) => api.updatePreferences(preferences),
    onSuccess: (saved) => {
      queryClient.setQueryData(PREFERENCES_KEY, saved);
      setDraft(null);
      toast({ tone: 'success', message: t('me:notifications.saved') });
    },
    onError: () => {
      toast({ tone: 'danger', message: t('me:notifications.failed') });
    },
  });

  const toggle = (kind: NotificationKind, channel: NotificationChannel, on: boolean): void => {
    setDraft({ ...shown, [kind]: { ...shown[kind], [channel]: on } });
  };

  return (
    <Box
      component="section"
      aria-labelledby="notification-preferences-heading"
      sx={{ display: 'flex', flexDirection: 'column', gap: 4 }}
    >
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
        <Typography
          id="notification-preferences-heading"
          component="h2"
          sx={{ fontSize: 16, lineHeight: '24px', fontWeight: 600 }}
        >
          {t('me:notifications.heading')}
        </Typography>
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          {t('me:notifications.caption', {
            email: view.email,
            language: t(`common:language.${view.locale}`),
          })}
        </Typography>
      </Box>

      <Paper
        component="form"
        elevation={0}
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate(shown);
        }}
        sx={{
          borderRadius: '10px',
          border: `1px solid ${tokens['border.default']}`,
          backgroundColor: tokens['bg.surface'],
          overflow: 'hidden',
        }}
      >
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell scope="col">{t('me:notifications.event')}</TableCell>
              {NOTIFICATION_CHANNELS.map((channel) => (
                <TableCell key={channel} scope="col" align="center" sx={{ width: 110 }}>
                  {t(`me:notifications.channels.${channel}`)}
                </TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {NOTIFICATION_KINDS.map((kind) => {
              const label = t(`me:notifications.kinds.${kind}.label`);

              return (
                <TableRow key={kind}>
                  <TableCell component="th" scope="row" sx={{ paddingBlock: 3 }}>
                    <Typography variant="body2" sx={{ fontWeight: 500 }}>
                      {label}
                    </Typography>
                    <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                      {t(`me:notifications.kinds.${kind}.hint`, { name: firstName })}
                    </Typography>
                  </TableCell>
                  {NOTIFICATION_CHANNELS.map((channel) => {
                    const pushOff = channel === 'push' && !view.push.configured;

                    return (
                      <TableCell key={channel} align="center">
                        <Checkbox
                          size="small"
                          checked={shown[kind][channel] && !pushOff}
                          disabled={pushOff || save.isPending}
                          onChange={(event) => {
                            toggle(kind, channel, event.target.checked);
                          }}
                          slotProps={{
                            input: {
                              'aria-label': t('me:notifications.cell', {
                                event: label,
                                channel: t(`me:notifications.channelNames.${channel}`),
                              }),
                            },
                          }}
                        />
                      </TableCell>
                    );
                  })}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        <Box
          sx={{
            paddingBlock: 3,
            paddingInline: 5,
            display: 'flex',
            alignItems: 'center',
            gap: 2,
            flexWrap: 'wrap',
            borderBlockStart: `1px solid ${tokens['border.default']}`,
            backgroundColor: tokens['bg.canvas'],
          }}
        >
          <Typography variant="caption" sx={{ color: 'text.secondary', marginInlineEnd: 'auto' }}>
            {t('me:notifications.footer')}
          </Typography>
          <Button
            variant="text"
            disabled={draft === null || save.isPending}
            onClick={() => {
              setDraft(null);
            }}
          >
            {t('me:notifications.discard')}
          </Button>
          <Button type="submit" variant="contained" disabled={draft === null || save.isPending}>
            {t('me:notifications.save')}
          </Button>
        </Box>
      </Paper>

      <Typography variant="caption" sx={{ color: 'text.secondary' }}>
        {t('me:notifications.note')}
      </Typography>
    </Box>
  );
}

const shortDate = (iso: string, locale: string): string =>
  new Intl.DateTimeFormat(locale === 'ar' ? 'ar-u-nu-latn' : locale, {
    day: 'numeric',
    month: 'short',
  }).format(new Date(iso));

function PushCard({ view }: { readonly view: NotificationPreferencesView }): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const api = useNotificationsApi();
  const push = useBrowserPush();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { locale } = usePreferences();
  const brandId = currentBrand(useSession()).id;
  const [permission, setPermission] = useState<PushPermission>(() => push.permission());
  const [storedId, setStoredId] = useState<string | null>(readStoredId);
  const subscribed = useQuery({
    queryKey: ['push', 'subscribed'],
    queryFn: () => push.subscribed(),
  });
  const mine = view.push.subscriptions.find((row) => row.id === storedId);
  const enabled = subscribed.data === true && mine !== undefined;
  const { browser, os } = push.device();
  const device = t('me:notifications.push.device', { browser, os });

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: PREFERENCES_KEY });
    await queryClient.invalidateQueries({ queryKey: ['push', 'subscribed'] });
  };

  const turnOn = useMutation({
    mutationFn: async () => {
      const subscription = await push.subscribe(view.push.publicKey ?? '');
      return api.subscribe(subscription);
    },
    onSuccess: async (saved) => {
      storeId(saved.id);
      setStoredId(saved.id);
      setPermission(push.permission());
      await refresh();
      toast({ tone: 'success', message: t('me:notifications.push.turnedOn') });
    },
    onError: (error) => {
      setPermission(push.permission());
      if (!(error instanceof PushDeniedError)) {
        toast({ tone: 'danger', message: t('me:notifications.push.failed') });
      }
    },
  });

  const turnOff = useMutation({
    mutationFn: async () => {
      if (storedId !== null) {
        await api.unsubscribe(storedId);
      }
      await push.unsubscribe();
    },
    onSuccess: async () => {
      storeId(null);
      setStoredId(null);
      await refresh();
      toast({ tone: 'success', message: t('me:notifications.push.turnedOff') });
    },
    onError: () => {
      toast({ tone: 'danger', message: t('me:notifications.failed') });
    },
  });

  const sendTest = useMutation({
    mutationFn: (subscriptionId: string) => api.testPush(brandId, subscriptionId),
    onSuccess: () => {
      toast({ tone: 'success', message: t('me:notifications.push.testSent') });
    },
    onError: () => {
      toast({ tone: 'danger', message: t('me:notifications.failed') });
    },
  });

  if (!view.push.configured) {
    return (
      <Notice
        tone="neutral"
        icon={<Lock size={14} aria-hidden="true" />}
        heading={t('me:notifications.push.notSetUpHeading')}
        body={t('me:notifications.push.notSetUpBody')}
      />
    );
  }
  if (permission === 'denied') {
    return (
      <Notice
        tone="warning"
        icon={<TriangleAlert size={14} aria-hidden="true" />}
        heading={t('me:notifications.push.blockedHeading')}
        body={t('me:notifications.push.blockedBody', { host: window.location.host })}
      />
    );
  }
  if (permission === 'unsupported') {
    return (
      <Notice
        tone="neutral"
        icon={<Monitor size={14} aria-hidden="true" />}
        heading={t('me:notifications.push.unsupportedHeading')}
        body={t('me:notifications.push.unsupportedBody')}
      />
    );
  }

  return (
    <Box
      component="section"
      aria-labelledby="push-card-heading"
      sx={{
        padding: 4,
        borderRadius: '10px',
        border: `1px solid ${tokens['border.default']}`,
        backgroundColor: tokens['bg.surface'],
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        <Monitor size={16} aria-hidden="true" />
        <Typography
          id="push-card-heading"
          component="h3"
          sx={{ fontSize: 14, lineHeight: '20px', fontWeight: 600 }}
        >
          {t('me:notifications.push.heading')}
        </Typography>
      </Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, fontSize: 13, flexWrap: 'wrap' }}>
        <Box
          component="span"
          aria-hidden="true"
          sx={{
            width: 8,
            height: 8,
            borderRadius: '999px',
            backgroundColor: enabled ? tokens['status.success'] : tokens['text.disabled'],
          }}
        />
        <Typography component="span" variant="body2" sx={{ fontWeight: 500 }}>
          {enabled ? t('me:notifications.push.enabled') : t('me:notifications.push.notEnabled')}
        </Typography>
        <Typography component="span" variant="body2" sx={{ color: 'text.secondary' }}>
          ·{' '}
          {enabled && mine !== undefined
            ? t('me:notifications.push.since', { date: shortDate(mine.createdAt, locale) })
            : device}
        </Typography>
      </Box>
      {enabled && mine !== undefined ? (
        <Box sx={{ display: 'flex', gap: 2 }}>
          <Button
            size="small"
            variant="outlined"
            disabled={sendTest.isPending}
            onClick={() => {
              sendTest.mutate(mine.id);
            }}
          >
            {t('me:notifications.push.test')}
          </Button>
          <Button
            size="small"
            variant="text"
            disabled={turnOff.isPending}
            onClick={() => {
              turnOff.mutate();
            }}
          >
            {t('me:notifications.push.turnOff')}
          </Button>
        </Box>
      ) : (
        <>
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            {t('me:notifications.push.askOnce')}
          </Typography>
          <Button
            variant="contained"
            disabled={turnOn.isPending}
            onClick={() => {
              turnOn.mutate();
            }}
            sx={{ alignSelf: 'flex-start' }}
          >
            {t('me:notifications.push.turnOn')}
          </Button>
        </>
      )}
    </Box>
  );
}

function Notice({
  tone,
  icon,
  heading,
  body,
}: {
  readonly tone: 'warning' | 'neutral';
  readonly icon: ReactNode;
  readonly heading: string;
  readonly body: string;
}): ReactNode {
  const tokens = useSemanticTokens();
  const look =
    tone === 'warning'
      ? {
          background: tokens['status.warning.tint'],
          border: tokens['status.warning'],
          color: tokens['status.warning.text'],
        }
      : {
          background: tokens['bg.muted'],
          border: tokens['border.default'],
          color: tokens['text.primary'],
        };

  return (
    <Box
      component="section"
      aria-label={heading}
      sx={{
        paddingBlock: 3,
        paddingInline: 4,
        borderRadius: '10px',
        border: `1px solid ${look.border}`,
        backgroundColor: look.background,
        color: look.color,
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, fontSize: 13, fontWeight: 500 }}>
        {icon}
        {heading}
      </Box>
      <Typography variant="body2" sx={{ color: 'inherit' }}>
        {body}
      </Typography>
    </Box>
  );
}
