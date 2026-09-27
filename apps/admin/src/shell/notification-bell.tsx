import type { NotificationKind, NotificationView } from '@helpdock/schemas';
import type { StatusName } from '@helpdock/ui';
import {
  Box,
  Button,
  Popover,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
  useTheme,
} from '@mui/material';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  AtSign,
  Bell,
  CheckCheck,
  ChevronsUp,
  CircleAlert,
  Clock,
  type LucideIcon,
  MessageSquare,
  Settings2,
  UserPlus,
} from 'lucide-react';
import { type MouseEvent, type ReactNode, useId, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useT } from '../app/i18n.js';
import { usePreferences } from '../app/providers.tsx';
import { ROUTES, ticketRoute } from '../app/route-paths.js';
import { useSemanticTokens } from '../app/tokens.js';
import { currentBrand, useSession } from '../auth/session.tsx';
import { useNotificationsApi } from '../notifications/context.tsx';
import {
  groupByDay,
  notificationCaption,
  notificationLine,
  notificationTitle,
} from '../notifications/format.js';
import { notificationsKey, useNotificationList } from '../notifications/use-notifications.js';
import { useToast } from '../ui/toasts.tsx';
import { visuallyHidden } from '../ui/visually-hidden.js';

/**
 * The bell in the sidebar's brand row and the panel it opens (M3-07, artboard
 * `AdminNotifications` panel 1; DESIGN §6.4 NotificationPanel).
 *
 * The unread count is drawn on the bell and **said in its name** — "Notifications,
 * 3 unread" — because a number in a dot is a colour and a shape, which is not a
 * label anybody can read (DESIGN §10). Opening a row marks it read and opens the
 * ticket; the panel lists the last 30 days of the brand on screen.
 */

type Tone = StatusName | 'primary' | 'neutral';

const KIND_LOOK: Record<NotificationKind, { readonly icon: LucideIcon; readonly tone: Tone }> = {
  sla_breached: { icon: CircleAlert, tone: 'danger' },
  sla_warning: { icon: Clock, tone: 'warning' },
  escalated: { icon: ChevronsUp, tone: 'escalated' },
  mentioned: { icon: AtSign, tone: 'primary' },
  assigned: { icon: UserPlus, tone: 'neutral' },
  replied: { icon: MessageSquare, tone: 'neutral' },
};

/** A two-digit badge at most: past 99 the exact number stops being information. */
const badgeText = (count: number): string => (count > 99 ? '99+' : String(count));

export function NotificationBell(): ReactNode {
  const t = useT();
  const theme = useTheme();
  const { locale } = usePreferences();
  // MUI anchors by physical side, so "the inline end of the sidebar" is
  // spelled per direction.
  const end = locale === 'ar' ? 'left' : 'right';
  const start = locale === 'ar' ? 'right' : 'left';
  const tokens = useSemanticTokens();
  const panelId = useId();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const bell = useNotificationList('all');
  const unread = bell.data?.unreadCount ?? 0;
  const open = anchor !== null;

  return (
    <>
      <Box
        component="button"
        type="button"
        aria-label={
          unread === 0
            ? t('admin:notifications.bell.label')
            : t('admin:notifications.bell.labelUnread', { count: unread })
        }
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={(event) => {
          setAnchor(event.currentTarget);
        }}
        sx={{
          position: 'relative',
          width: 32,
          height: 32,
          flexShrink: 0,
          border: 0,
          borderRadius: '6px',
          backgroundColor: open ? tokens['bg.muted'] : 'transparent',
          color: tokens['text.primary'],
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          '&:hover': { backgroundColor: tokens['bg.muted'] },
        }}
      >
        <Bell size={16} aria-hidden="true" />
        {unread === 0 ? null : (
          <Box
            component="span"
            aria-hidden="true"
            sx={{
              position: 'absolute',
              insetBlockStart: 0,
              insetInlineEnd: 0,
              minWidth: 18,
              height: 18,
              paddingInline: 1,
              boxSizing: 'border-box',
              borderRadius: '999px',
              backgroundColor: tokens['action.primary'],
              color: tokens['action.primary.text'],
              fontFamily: theme.typography.mono.fontFamily,
              fontSize: 11,
              fontWeight: 500,
              lineHeight: '18px',
              textAlign: 'center',
            }}
          >
            {badgeText(unread)}
          </Box>
        )}
      </Box>

      <Popover
        id={panelId}
        open={open}
        anchorEl={anchor}
        onClose={() => {
          setAnchor(null);
        }}
        anchorOrigin={{ vertical: 'top', horizontal: end }}
        transformOrigin={{ vertical: 'top', horizontal: start }}
        slotProps={{
          paper: {
            role: 'dialog',
            'aria-labelledby': `${panelId}-title`,
            sx: {
              width: 400,
              maxWidth: 'calc(100vw - 32px)',
              marginInlineStart: 2,
              borderRadius: '10px',
              border: `1px solid ${tokens['border.default']}`,
            },
          },
        }}
      >
        <NotificationPanel
          titleId={`${panelId}-title`}
          onClose={() => {
            setAnchor(null);
          }}
        />
      </Popover>
    </>
  );
}

function NotificationPanel({
  titleId,
  onClose,
}: {
  readonly titleId: string;
  readonly onClose: () => void;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const api = useNotificationsApi();
  const brandId = currentBrand(useSession()).id;
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const [filter, setFilter] = useState<'all' | 'unread'>('all');
  const list = useNotificationList(filter);
  const unread = list.data?.unreadCount ?? 0;

  const refresh = (): Promise<void> =>
    queryClient.invalidateQueries({ queryKey: notificationsKey(brandId) });

  const markAll = useMutation({
    mutationFn: () => api.markAllRead(brandId),
    onSuccess: refresh,
    onError: () => {
      toast({ tone: 'danger', message: t('admin:notifications.panel.loadFailed') });
    },
  });

  const open = useMutation({
    mutationFn: (item: NotificationView) =>
      item.readAt === null ? api.markRead(brandId, item.id) : Promise.resolve(),
    onSettled: refresh,
  });

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column' }}>
      <Box
        sx={{
          paddingBlock: 3,
          paddingInline: 4,
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          borderBlockEnd: `1px solid ${tokens['border.default']}`,
        }}
      >
        <Typography
          id={titleId}
          component="h2"
          sx={{ fontSize: 16, lineHeight: '24px', fontWeight: 600 }}
        >
          {t('admin:notifications.panel.title')}
        </Typography>
        {unread === 0 ? null : (
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            {t('admin:notifications.panel.unread', { count: unread })}
          </Typography>
        )}
        <Button
          size="small"
          variant="text"
          startIcon={<CheckCheck size={14} aria-hidden="true" />}
          disabled={unread === 0 || markAll.isPending}
          onClick={() => {
            markAll.mutate();
          }}
          sx={{ marginInlineStart: 'auto' }}
        >
          {t('admin:notifications.panel.markAllRead')}
        </Button>
      </Box>

      <Box sx={{ paddingBlockStart: 2, paddingInline: 4 }}>
        <ToggleButtonGroup
          exclusive
          size="small"
          value={filter}
          aria-label={t('admin:notifications.panel.show')}
          onChange={(_event, next: 'all' | 'unread' | null) => {
            if (next !== null) {
              setFilter(next);
            }
          }}
        >
          <ToggleButton value="all">{t('admin:notifications.panel.all')}</ToggleButton>
          <ToggleButton value="unread">{t('admin:notifications.panel.unreadFilter')}</ToggleButton>
        </ToggleButtonGroup>
      </Box>

      <Box sx={{ maxHeight: 480, overflowY: 'auto' }}>
        {list.isError ? (
          <Typography variant="body2" role="alert" sx={{ padding: 4, color: 'text.secondary' }}>
            {t('admin:notifications.panel.loadFailed')}
          </Typography>
        ) : list.data === undefined ? null : list.data.items.length === 0 ? (
          <PanelEmpty unreadOnly={filter === 'unread'} onClose={onClose} />
        ) : (
          <NotificationRows
            items={list.data.items}
            onOpen={(item) => {
              open.mutate(item);
              onClose();
              void navigate(ticketRoute(item.ticketId));
            }}
          />
        )}
      </Box>

      <Box
        sx={{
          paddingBlock: 2,
          paddingInline: 4,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderBlockStart: `1px solid ${tokens['border.default']}`,
        }}
      >
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          {t('admin:notifications.panel.window')}
        </Typography>
        <Box
          component={Link}
          to={ROUTES.meNotifications}
          onClick={onClose}
          sx={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 1,
            fontSize: 13,
            fontWeight: 500,
            color: tokens['text.link'],
            textDecoration: 'none',
          }}
        >
          <Settings2 size={14} aria-hidden="true" />
          {t('admin:notifications.panel.settings')}
        </Box>
      </Box>
    </Box>
  );
}

function PanelEmpty({
  unreadOnly,
  onClose,
}: {
  readonly unreadOnly: boolean;
  readonly onClose: () => void;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();

  if (unreadOnly) {
    return (
      <Typography variant="body2" sx={{ padding: 4, color: 'text.secondary' }}>
        {t('admin:notifications.panel.emptyUnread')}
      </Typography>
    );
  }

  return (
    <Box
      sx={{
        paddingBlock: 8,
        paddingInline: 6,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 2,
        textAlign: 'center',
      }}
    >
      <Bell size={24} aria-hidden="true" color={tokens['text.disabled']} />
      <Typography variant="h3" component="h3">
        {t('admin:notifications.panel.emptyHeading')}
      </Typography>
      <Typography variant="body2" sx={{ color: 'text.secondary' }}>
        {t('admin:notifications.panel.emptyBody')}
      </Typography>
      <Box
        component={Link}
        to={ROUTES.meNotifications}
        onClick={onClose}
        sx={{ fontSize: 13, fontWeight: 500, color: tokens['text.link'] }}
      >
        {t('admin:notifications.panel.settings')}
      </Box>
    </Box>
  );
}

function NotificationRows({
  items,
  onOpen,
}: {
  readonly items: readonly NotificationView[];
  readonly onOpen: (item: NotificationView) => void;
}): ReactNode {
  const t = useT();
  const { locale } = usePreferences();
  const tokens = useSemanticTokens();
  const [now] = useState(() => Date.now());

  return (
    <Box
      component="ul"
      aria-label={t('admin:notifications.panel.list')}
      sx={{
        listStyle: 'none',
        margin: 0,
        padding: 2,
        display: 'flex',
        flexDirection: 'column',
        gap: 0.5,
      }}
    >
      {groupByDay(items, now).map(({ group, items: rows }) => [
        <Box
          component="li"
          key={`group-${group}`}
          sx={{
            paddingBlock: '4px 2px',
            paddingInline: 3,
            fontSize: 12,
            fontWeight: 500,
            color: 'text.secondary',
          }}
        >
          {t(`admin:notifications.panel.${group}`)}
        </Box>,
        ...rows.map((item) => {
          const look = KIND_LOOK[item.kind];
          const Icon = look.icon;
          const isUnread = item.readAt === null;
          const tint =
            look.tone === 'primary'
              ? { background: tokens['action.primary.tint'], color: tokens['text.link'] }
              : look.tone === 'neutral'
                ? { background: tokens['bg.muted'], color: tokens['text.secondary'] }
                : {
                    background: tokens[`status.${look.tone}.tint`],
                    color: tokens[`status.${look.tone}.text`],
                  };

          return (
            <Box component="li" key={item.id}>
              <Box
                component="a"
                href={ticketRoute(item.ticketId)}
                onClick={(event: MouseEvent) => {
                  event.preventDefault();
                  onOpen(item);
                }}
                sx={{
                  display: 'flex',
                  gap: 3,
                  paddingBlock: 2,
                  paddingInline: 3,
                  borderRadius: '6px',
                  color: tokens['text.primary'],
                  textDecoration: 'none',
                  backgroundColor: isUnread ? tokens['bg.canvas'] : 'transparent',
                  '&:hover': { backgroundColor: tokens['bg.muted'] },
                }}
              >
                <Box
                  component="span"
                  sx={{
                    width: 28,
                    height: 28,
                    borderRadius: '6px',
                    flexShrink: 0,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: tint.background,
                    color: tint.color,
                  }}
                >
                  <Icon size={14} aria-hidden="true" />
                </Box>
                <Box
                  component="span"
                  sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 0.5 }}
                >
                  <Typography
                    component="span"
                    variant="body2"
                    sx={{ fontWeight: isUnread ? 500 : 400 }}
                  >
                    {notificationTitle(t, item)}
                  </Typography>
                  <Typography
                    component="span"
                    noWrap
                    sx={{ fontSize: 13, color: isUnread ? 'text.primary' : 'text.secondary' }}
                  >
                    <Typography component="bdi" variant="mono" sx={{ fontSize: 'inherit' }}>
                      {item.ticketReference}
                    </Typography>{' '}
                    <bdi>{notificationLine(t, item)}</bdi>
                  </Typography>
                  <Typography component="span" variant="caption" sx={{ color: 'text.secondary' }}>
                    {notificationCaption(t, item, locale, now)}
                  </Typography>
                </Box>
                {isUnread ? (
                  <Box
                    component="span"
                    sx={{
                      width: 8,
                      height: 8,
                      marginBlockStart: 2,
                      borderRadius: '999px',
                      flexShrink: 0,
                      backgroundColor: tokens['action.primary'],
                    }}
                  >
                    <Box component="span" sx={visuallyHidden}>
                      {t('admin:notifications.panel.unreadDot')}
                    </Box>
                  </Box>
                ) : null}
              </Box>
            </Box>
          );
        }),
      ])}
    </Box>
  );
}
