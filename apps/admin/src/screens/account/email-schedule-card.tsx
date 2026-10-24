import {
  EMAIL_SCHEDULES,
  type EmailSchedule,
  type NotificationPreferencesUpdate,
  type NotificationPreferencesView,
} from '@helpdock/schemas';
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Menu,
  MenuItem,
  NativeSelect,
  TextField,
  Typography,
} from '@mui/material';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Mail, Pause } from 'lucide-react';
import { type FormEvent, type ReactNode, useId, useState } from 'react';
import { useT } from '../../app/i18n.js';
import { usePreferences } from '../../app/providers.tsx';
import { useSemanticTokens } from '../../app/tokens.js';
import { isAuthError } from '../../auth/api.js';
import { currentBrand, useSession } from '../../auth/session.tsx';
import { useNotificationsApi } from '../../notifications/context.tsx';
import {
  browserZone,
  hourLabel,
  hourOptions,
  pauseDateBounds,
  pauseDateEnd,
  pausePresets,
  whenLabel,
} from '../../notifications/email-status.js';
import { EmailStatusLines } from '../../notifications/email-status-line.tsx';
import { PREFERENCES_KEY } from '../../notifications/use-preferences.js';
import { RadioCard } from '../../ui/radio-card.tsx';
import { useToast } from '../../ui/toasts.tsx';
import { visuallyHidden } from '../../ui/visually-hidden.js';

/**
 * The Email schedule card of Your account › Notifications (M14-11,
 * `Admin/Account-Notifications-Schedule`, en and ar): above the event matrix,
 * four RadioCards (Right away by default, owner decision D-25) with the daily
 * digest's hour, Pause, and "Send me a test email".
 *
 * The schedule and the hour are a draft until Save, as the matrix is; a pause,
 * a resume and a test email act at once, because each is a button with its own
 * answer. The card says why email is not reaching the person when something
 * stops it (paused, unsubscribed, Off, an install with no outgoing email).
 */

export function EmailScheduleCard({
  view,
}: {
  readonly view: NotificationPreferencesView;
}): ReactNode {
  const t = useT();
  const api = useNotificationsApi();
  const tokens = useSemanticTokens();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { locale } = usePreferences();
  const brandId = currentBrand(useSession()).id;
  const groupId = useId();
  const { emailDelivery } = view;
  const zone = view.digestTimeZone ?? browserZone();
  const [schedule, setSchedule] = useState<EmailSchedule>(emailDelivery.schedule);
  const [hour, setHour] = useState(emailDelivery.digestHour);
  const [pauseAnchor, setPauseAnchor] = useState<HTMLElement | null>(null);
  const [dateOpen, setDateOpen] = useState(false);
  const dirty = schedule !== emailDelivery.schedule || hour !== emailDelivery.digestHour;

  // The saved view moved under an untouched draft (a resume, a refetch): follow it.
  const [seen, setSeen] = useState(emailDelivery);
  if (seen !== emailDelivery) {
    setSeen(emailDelivery);
    if (!dirty) {
      setSchedule(emailDelivery.schedule);
      setHour(emailDelivery.digestHour);
    }
  }

  const apply = useMutation({
    mutationFn: (update: NotificationPreferencesUpdate) => api.updateSettings(update),
    onSuccess: (saved, update) => {
      queryClient.setQueryData(PREFERENCES_KEY, saved);
      if (update.pausedUntil === undefined) {
        toast({ tone: 'success', message: t('me:notifications.schedule.saved') });
      } else {
        toast({
          tone: 'success',
          message:
            update.pausedUntil === null
              ? t('me:notifications.schedule.toast.resumed')
              : t('me:notifications.schedule.toast.paused', {
                  when: whenLabel(update.pausedUntil, locale, Date.now(), zone),
                }),
        });
      }
    },
    onError: () => {
      toast({ tone: 'danger', message: t('me:notifications.schedule.toast.failed') });
    },
  });

  const testEmail = useMutation({
    mutationFn: () => api.testEmail(brandId),
    onSuccess: () => {
      toast({
        tone: 'success',
        message: t('me:notifications.schedule.toast.testSent', { email: view.email }),
      });
    },
    onError: (error) => {
      const status = isAuthError(error) ? error.status : undefined;
      const rateLimited = isAuthError(error) && error.code === 'rate-limited';
      toast({
        tone: 'danger',
        message: rateLimited
          ? t('me:notifications.schedule.toast.testLimit')
          : status === 409
            ? t('me:notifications.schedule.toast.testNotConfigured')
            : t('me:notifications.schedule.toast.failed'),
      });
    },
  });

  const save = (): void => {
    apply.mutate({
      ...(schedule === emailDelivery.schedule ? {} : { emailSchedule: schedule }),
      ...(hour === emailDelivery.digestHour ? {} : { digestHour: hour }),
    });
  };

  const pause = (until: Date): void => {
    setPauseAnchor(null);
    setDateOpen(false);
    apply.mutate({ pausedUntil: until.toISOString() });
  };

  const now = new Date();
  const presets = pausePresets(now, zone);

  return (
    <Box
      component="section"
      aria-labelledby={`${groupId}-heading`}
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
          id={`${groupId}-heading`}
          component="h2"
          sx={{ fontSize: 16, lineHeight: '24px', fontWeight: 600 }}
        >
          {t('me:notifications.schedule.heading')}
        </Typography>
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          {t('me:notifications.schedule.caption')}
        </Typography>
      </Box>

      <Box sx={{ padding: 5, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <EmailStatusLines view={view} />

        <Box
          component="fieldset"
          role="radiogroup"
          sx={{
            margin: 0,
            padding: 0,
            border: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
          }}
        >
          <Box component="legend" sx={visuallyHidden}>
            {t('me:notifications.schedule.legend')}
          </Box>
          <Box sx={{ display: 'contents' }}>
            {EMAIL_SCHEDULES.map((option) => (
              <RadioCard
                key={option}
                id={`${groupId}-${option}`}
                name={`${groupId}-schedule`}
                value={option}
                checked={schedule === option}
                disabled={apply.isPending}
                title={t(`me:notifications.schedule.options.${option}.title`)}
                description={
                  option === 'daily' ? (
                    <DailyHour
                      hour={hour}
                      zone={view.digestTimeZone}
                      disabled={apply.isPending}
                      onChange={(next) => {
                        setHour(next);
                        setSchedule('daily');
                      }}
                    />
                  ) : (
                    t(`me:notifications.schedule.options.${option}.description`)
                  )
                }
                onSelect={() => {
                  setSchedule(option);
                }}
              />
            ))}
          </Box>
        </Box>

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 3, flexWrap: 'wrap' }}>
          <Button
            variant="outlined"
            size="small"
            startIcon={<Pause size={16} aria-hidden="true" />}
            aria-haspopup="menu"
            aria-expanded={pauseAnchor !== null}
            disabled={apply.isPending}
            onClick={(event) => {
              setPauseAnchor(event.currentTarget);
            }}
          >
            {t('me:notifications.schedule.pause')}
          </Button>
          <Button
            variant="text"
            size="small"
            startIcon={<Mail size={16} aria-hidden="true" />}
            disabled={testEmail.isPending || !view.emailConfigured}
            onClick={() => {
              testEmail.mutate();
            }}
          >
            {t('me:notifications.schedule.testEmail')}
          </Button>
        </Box>
      </Box>

      <Box
        sx={{
          paddingBlock: 3,
          paddingInline: 5,
          display: 'flex',
          justifyContent: 'flex-end',
          gap: 2,
          borderBlockStart: `1px solid ${tokens['border.default']}`,
          backgroundColor: tokens['bg.canvas'],
        }}
      >
        <Button
          variant="text"
          aria-label={t('me:notifications.schedule.discardLabel')}
          disabled={!dirty || apply.isPending}
          onClick={() => {
            setSchedule(emailDelivery.schedule);
            setHour(emailDelivery.digestHour);
          }}
        >
          {t('me:notifications.schedule.discard')}
        </Button>
        <Button variant="contained" disabled={!dirty || apply.isPending} onClick={save}>
          {t('me:notifications.schedule.save')}
        </Button>
      </Box>

      <Menu
        anchorEl={pauseAnchor}
        open={pauseAnchor !== null}
        onClose={() => {
          setPauseAnchor(null);
        }}
        slotProps={{
          list: { 'aria-label': t('me:notifications.schedule.pauseMenu.label'), dense: true },
          paper: { sx: { minWidth: 260, padding: '6px', borderRadius: '10px' } },
        }}
      >
        <PauseItem
          label={t('me:notifications.schedule.pauseMenu.oneHour')}
          hint={t('me:notifications.schedule.pauseMenu.until', {
            when: whenLabel(presets.hour, locale, now.getTime(), zone),
          })}
          onPick={() => {
            pause(presets.hour);
          }}
        />
        <PauseItem
          label={t('me:notifications.schedule.pauseMenu.tomorrow')}
          onPick={() => {
            pause(presets.tomorrow);
          }}
        />
        <PauseItem
          label={t('me:notifications.schedule.pauseMenu.oneWeek')}
          hint={t('me:notifications.schedule.pauseMenu.until', {
            when: whenLabel(presets.week, locale, now.getTime(), zone).replace(
              /, \d{2}:\d{2}$/,
              '',
            ),
          })}
          onPick={() => {
            pause(presets.week);
          }}
        />
        <Divider component="li" sx={{ marginBlock: 1 }} />
        <PauseItem
          label={t('me:notifications.schedule.pauseMenu.date')}
          onPick={() => {
            setPauseAnchor(null);
            setDateOpen(true);
          }}
        />
      </Menu>

      <PauseDateDialog
        open={dateOpen}
        busy={apply.isPending}
        onClose={() => {
          setDateOpen(false);
        }}
        zone={zone}
        onPick={pause}
      />
    </Box>
  );
}

function DailyHour({
  hour,
  zone,
  disabled,
  onChange,
}: {
  readonly hour: number;
  readonly zone: string | null;
  readonly disabled: boolean;
  onChange(hour: number): void;
}): ReactNode {
  const t = useT();
  const selectId = useId();

  return (
    <Box
      component="span"
      sx={{ display: 'inline-flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}
    >
      <span>{t('me:notifications.schedule.options.daily.lead')}</span>
      <NativeSelect
        value={hour}
        disabled={disabled}
        onChange={(event) => {
          onChange(Number(event.target.value));
        }}
        inputProps={{
          id: selectId,
          'aria-label': t('me:notifications.schedule.hour'),
          dir: 'ltr',
        }}
        sx={{ fontSize: 13, minWidth: 80 }}
      >
        {hourOptions.map((option) => (
          <option key={option} value={option}>
            {hourLabel(option)}
          </option>
        ))}
      </NativeSelect>
      {zone === null ? null : (
        <Typography component="bdi" variant="mono" sx={{ fontSize: 12 }}>
          {zone}
        </Typography>
      )}
    </Box>
  );
}

function PauseItem({
  label,
  hint,
  onPick,
}: {
  readonly label: string;
  readonly hint?: string;
  onPick(): void;
}): ReactNode {
  return (
    <MenuItem
      onClick={onPick}
      sx={{
        minHeight: 32,
        borderRadius: '4px',
        fontSize: 13,
        gap: 3,
        justifyContent: 'space-between',
      }}
    >
      <span>{label}</span>
      {hint === undefined ? null : (
        <Typography component="span" variant="caption" sx={{ color: 'text.secondary' }}>
          {hint}
        </Typography>
      )}
    </MenuItem>
  );
}

/** "Until a date…": a native date input, bounded to what the api accepts. */
function PauseDateDialog({
  open,
  busy,
  zone,
  onClose,
  onPick,
}: {
  readonly open: boolean;
  readonly busy: boolean;
  readonly zone: string;
  onClose(): void;
  onPick(end: Date): void;
}): ReactNode {
  const t = useT();
  const titleId = useId();
  const [value, setValue] = useState('');
  const [touched, setTouched] = useState(false);
  const now = new Date();
  const bounds = pauseDateBounds(now, zone);
  const result = pauseDateEnd(value, now, zone);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setTouched(true);
    if (result.problem === null) {
      onPick(result.end);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullWidth
      aria-labelledby={titleId}
      slotProps={{
        paper: { sx: { maxWidth: 400 } },
        transition: {
          onEnter: () => {
            setValue(bounds.min);
            setTouched(false);
          },
        },
      }}
    >
      <Box component="form" noValidate onSubmit={submit}>
        <DialogTitle id={titleId} variant="h3">
          {t('me:notifications.schedule.pauseDialog.title')}
        </DialogTitle>
        <DialogContent sx={{ display: 'grid', gap: 3 }}>
          <TextField
            type="date"
            label={t('me:notifications.schedule.pauseDialog.when')}
            value={value}
            size="small"
            fullWidth
            onChange={(event) => {
              setValue(event.target.value);
              setTouched(true);
            }}
            slotProps={{
              inputLabel: { shrink: true },
              formHelperText: { role: 'alert' },
              htmlInput: { min: bounds.min, max: bounds.max, dir: 'ltr' },
            }}
            error={touched && result.problem !== null}
            helperText={
              touched && result.problem !== null
                ? t(`me:notifications.schedule.pauseDialog.${result.problem}`)
                : undefined
            }
          />
          <Typography variant="caption" color="text.secondary">
            {t('me:notifications.schedule.pauseDialog.hint')}
          </Typography>
        </DialogContent>
        <DialogActions sx={{ padding: 5, paddingBlockStart: 2 }}>
          <Button variant="outlined" onClick={onClose}>
            {t('me:notifications.schedule.pauseDialog.cancel')}
          </Button>
          <Button type="submit" variant="contained" disabled={busy || result.problem !== null}>
            {t('me:notifications.schedule.pauseDialog.confirm')}
          </Button>
        </DialogActions>
      </Box>
    </Dialog>
  );
}
