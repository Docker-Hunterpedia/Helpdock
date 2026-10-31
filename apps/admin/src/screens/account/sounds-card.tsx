import {
  type NotificationPreferencesView,
  type NotificationSounds,
  SOUND_EVENTS,
  type SoundEvent,
} from '@helpdock/schemas';
import { Box, Checkbox, FormControlLabel, IconButton, Typography } from '@mui/material';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Info, Play } from 'lucide-react';
import { type ReactNode, useId } from 'react';
import { useT } from '../../app/i18n.js';
import { useSemanticTokens } from '../../app/tokens.js';
import { useNotificationsApi } from '../../notifications/context.tsx';
import { soundPlayer } from '../../notifications/sounds/player.js';
import { PREFERENCES_KEY } from '../../notifications/use-preferences.js';
import { Switch } from '../../ui/switch.tsx';
import { useToast } from '../../ui/toasts.tsx';

/**
 * The Sounds card of Your account › Notifications (M14-25,
 * `Admin/Account-Notifications-Sounds`, en and ar): a Switch per event, all off
 * until chosen, the waiting-chat reminder under the first, a Play button for
 * each sound, and the note that a browser may keep a background tab quiet.
 *
 * A change is saved as soon as it is made, like the Pause menu's buttons: each
 * control is its own answer, and a Save button for five switches would only
 * hold a choice back from the next chat that arrives. The saved view is the
 * truth, kept on the person's account, so the choice follows them to another
 * browser.
 */

const SOUNDS_MUTATION = ['me', 'notification-sounds'] as const;

export function SoundsCard({ view }: { readonly view: NotificationPreferencesView }): ReactNode {
  const t = useT();
  const api = useNotificationsApi();
  const tokens = useSemanticTokens();
  const toast = useToast();
  const queryClient = useQueryClient();
  const headingId = useId();
  const noteId = useId();

  const save = useMutation({
    mutationKey: SOUNDS_MUTATION,
    mutationFn: (sounds: NotificationSounds) => api.updateSettings({ sounds }),
    // Optimistic, so the switch moves under the finger; the answer replaces it.
    onMutate: (sounds) => {
      // Not awaited: the switch must move in the same frame as the press.
      void queryClient.cancelQueries({ queryKey: PREFERENCES_KEY });
      const previous = queryClient.getQueryData<NotificationPreferencesView>(PREFERENCES_KEY);
      queryClient.setQueryData<NotificationPreferencesView>(PREFERENCES_KEY, (current) =>
        current === undefined ? current : { ...current, sounds },
      );

      return { previous };
    },
    // Two quick changes are two requests: only the last answer may replace the
    // view, or the first one's would flip the second's switch back.
    onSuccess: (saved) => {
      if (queryClient.isMutating({ mutationKey: SOUNDS_MUTATION }) <= 1) {
        queryClient.setQueryData(PREFERENCES_KEY, saved);
      }
    },
    onError: (_error, _sounds, context) => {
      queryClient.setQueryData(PREFERENCES_KEY, context?.previous);
      toast({ tone: 'danger', message: t('me:notifications.sounds.failed') });
    },
  });

  const change = (patch: Partial<NotificationSounds>): void => {
    save.mutate({ ...view.sounds, ...patch });
  };

  return (
    <Box
      component="section"
      aria-labelledby={headingId}
      sx={{
        borderRadius: '10px',
        border: `1px solid ${tokens['border.default']}`,
        backgroundColor: tokens['bg.surface'],
        overflow: 'hidden',
      }}
    >
      <Box
        sx={{
          paddingBlock: 4,
          paddingInline: 5,
          borderBlockEnd: `1px solid ${tokens['border.default']}`,
          display: 'flex',
          flexDirection: 'column',
          gap: 0.5,
        }}
      >
        <Typography
          id={headingId}
          component="h2"
          sx={{ fontSize: 16, lineHeight: '24px', fontWeight: 600 }}
        >
          {t('me:notifications.sounds.heading')}
        </Typography>
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          {t('me:notifications.sounds.caption')}
        </Typography>
      </Box>

      <Box sx={{ padding: 5, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {SOUND_EVENTS.map((event) => (
          <SoundRow
            key={event}
            event={event}
            label={t(`me:notifications.sounds.events.${event}`)}
            on={view.sounds[event]}
            onChange={(on) => {
              change({ [event]: on });
            }}
          >
            {event === 'waitingChat' ? (
              <FormControlLabel
                sx={{ marginInlineStart: 0, marginInlineEnd: 0, gap: 1 }}
                control={
                  <Checkbox
                    size="small"
                    checked={view.sounds.waitingChatReminder}
                    disabled={!view.sounds.waitingChat}
                    onChange={(changed) => {
                      change({ waitingChatReminder: changed.target.checked });
                    }}
                    sx={{ padding: 0 }}
                  />
                }
                label={
                  <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                    {t('me:notifications.sounds.reminder')}
                  </Typography>
                }
              />
            ) : null}
          </SoundRow>
        ))}

        <Box
          component="p"
          id={noteId}
          sx={{
            margin: 0,
            display: 'flex',
            gap: 2,
            alignItems: 'flex-start',
            color: 'text.secondary',
            fontSize: 12,
            lineHeight: '16px',
          }}
        >
          <Info size={16} aria-hidden="true" style={{ flexShrink: 0 }} />
          <span>{t('me:notifications.sounds.note')}</span>
        </Box>
      </Box>
    </Box>
  );
}

function SoundRow({
  event,
  label,
  on,
  onChange,
  children,
}: {
  readonly event: SoundEvent;
  readonly label: string;
  readonly on: boolean;
  onChange(on: boolean): void;
  readonly children?: ReactNode;
}): ReactNode {
  const t = useT();

  return (
    <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 3 }}>
      <Box sx={{ paddingBlockStart: '2px' }}>
        <Switch checked={on} label={label} onChange={onChange} />
      </Box>
      <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
        <Typography variant="body2" sx={{ fontWeight: 500 }}>
          {label}
        </Typography>
        {children}
      </Box>
      <IconButton
        size="small"
        aria-label={t('me:notifications.sounds.play', { event: label })}
        onClick={() => {
          void soundPlayer.play(event, { interrupt: true });
        }}
        sx={{ color: 'text.secondary' }}
      >
        <Play size={16} aria-hidden="true" />
      </IconButton>
    </Box>
  );
}
