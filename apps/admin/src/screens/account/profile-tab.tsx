import {
  JOB_TITLE_MAX_LENGTH,
  normalisePhone,
  PROFILE_PHOTO_MAX_BYTES,
  PROFILE_PHOTO_MIME_TYPES,
  type Profile,
  type ProfileUpdateRequest,
  PUBLIC_NAME_MAX_LENGTH,
  PUBLIC_PHONE_MAX_LENGTH,
  splitName,
} from '@helpdock/schemas';
import { Avatar, Box, Button, TextField, Typography } from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Camera } from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { useT } from '../../app/i18n.js';
import { useSemanticTokens } from '../../app/tokens.js';
import { useStaffApi } from '../../auth/session.tsx';
import { useKeyboard } from '../../keyboard/keyboard-provider.js';
import { isStaffError } from '../../staff/api.js';
import { AlertBanner } from '../../ui/alert-banner.tsx';
import { Field } from '../../ui/field.tsx';
import { Switch } from '../../ui/switch.tsx';
import { useToast } from '../../ui/toasts.tsx';
import { TimeZoneSelect } from '../admin/ticketing/time-zone-select.tsx';

/**
 * Your account › Profile (artboard `Admin/Account-Profile`, M14-12): how the
 * person appears to customers (a public name, a job title in each language, a
 * phone number and a photo) and the one setting that is about working in
 * Helpdock rather than about customers, the single-key shortcuts switch.
 *
 * The photo is saved the moment it is chosen: it is a file, not a field, and
 * the api answers with the cropped result. The fields are saved together with
 * Save changes, and Discard puts the stored values back. The time zone shows
 * the browser's until one is saved.
 */

export const PROFILE_KEY = ['me', 'profile'] as const;

interface Draft {
  readonly name: string;
  readonly publicName: string;
  readonly jobTitleEn: string;
  readonly jobTitleAr: string;
  readonly phone: string;
  readonly timeZone: string;
}

const browserTimeZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return 'UTC';
  }
};

const draftOf = (profile: Profile): Draft => ({
  name: profile.name,
  publicName: profile.publicName ?? '',
  jobTitleEn: profile.jobTitleEn ?? '',
  jobTitleAr: profile.jobTitleAr ?? '',
  phone: profile.phone ?? '',
  timeZone: profile.timeZone ?? browserTimeZone(),
});

const orNull = (value: string): string | null => (value.trim() === '' ? null : value.trim());

type PhotoProblem =
  | 'photoTooLarge'
  | 'photoUnsupported'
  | 'photoUnreadable'
  | 'photoSlowDown'
  | 'photoFailed';

const PHOTO_PROBLEM = {
  'photo-too-large': 'photoTooLarge',
  'photo-unsupported-type': 'photoUnsupported',
  'photo-unreadable': 'photoUnreadable',
  'photo-rate-limited': 'photoSlowDown',
  'photo-missing': 'photoFailed',
} as const satisfies Record<string, PhotoProblem>;

export function ProfileTab(): ReactNode {
  const t = useT();
  const api = useStaffApi();
  const toast = useToast();
  const tokens = useSemanticTokens();
  const queryClient = useQueryClient();
  const keyboard = useKeyboard();
  const id = useId();
  const fileInput = useRef<HTMLInputElement>(null);

  const stored = useQuery({ queryKey: PROFILE_KEY, queryFn: () => api.profile() });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [phoneWrong, setPhoneWrong] = useState(false);
  const [photoProblem, setPhotoProblem] = useState<PhotoProblem | null>(null);

  useEffect(() => {
    if (stored.data !== undefined) {
      setDraft(draftOf(stored.data));
    }
  }, [stored.data]);

  const keep = async (profile: Profile): Promise<void> => {
    queryClient.setQueryData(PROFILE_KEY, profile);
    await queryClient.invalidateQueries({ queryKey: PROFILE_KEY });
  };

  const save = useMutation({
    mutationFn: (request: ProfileUpdateRequest) => api.updateProfile(request),
    onSuccess: async (profile) => {
      setPhoneWrong(false);
      await keep(profile);
      toast({ tone: 'success', message: t('me:profile.saved') });
    },
    onError: (error: unknown) => {
      if (isStaffError(error) && error.reason === 'invalid-phone') {
        setPhoneWrong(true);
        return;
      }
      toast({ tone: 'danger', message: t('me:profile.failed') });
    },
  });

  const upload = useMutation({
    mutationFn: (file: File) => api.uploadPhoto(file),
    onSuccess: async (profile) => {
      setPhotoProblem(null);
      await keep(profile);
      toast({ tone: 'success', message: t('me:profile.photoUpdated') });
    },
    onError: (error: unknown) => {
      setPhotoProblem(
        isStaffError(error) && error.reason in PHOTO_PROBLEM
          ? PHOTO_PROBLEM[error.reason as keyof typeof PHOTO_PROBLEM]
          : 'photoFailed',
      );
    },
  });

  const remove = useMutation({
    mutationFn: () => api.removePhoto(),
    onSuccess: async (profile) => {
      setPhotoProblem(null);
      await keep(profile);
      toast({ tone: 'success', message: t('me:profile.photoRemoved') });
    },
    onError: () => {
      setPhotoProblem('photoFailed');
    },
  });

  if (stored.isError) {
    return <AlertBanner tone="danger">{t('me:profile.loadFailed')}</AlertBanner>;
  }
  if (stored.data === undefined || draft === null) {
    return null;
  }
  const profile = stored.data;

  const choose = (file: File | undefined): void => {
    if (file === undefined) {
      return;
    }
    // The api refuses the same things; saying so here saves a round trip.
    if (file.size > PROFILE_PHOTO_MAX_BYTES) {
      setPhotoProblem('photoTooLarge');
    } else if (!(PROFILE_PHOTO_MIME_TYPES as readonly string[]).includes(file.type)) {
      setPhotoProblem('photoUnsupported');
    } else {
      upload.mutate(file);
    }
    if (fileInput.current !== null) {
      fileInput.current.value = '';
    }
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const phone = orNull(draft.phone);
    if (phone !== null && !normalisePhone(phone).ok) {
      setPhoneWrong(true);
      return;
    }
    setPhoneWrong(false);
    save.mutate({
      name: draft.name.trim() === '' ? profile.name : draft.name.trim(),
      publicName: orNull(draft.publicName),
      jobTitleEn: orNull(draft.jobTitleEn),
      jobTitleAr: orNull(draft.jobTitleAr),
      phone,
      timeZone: draft.timeZone,
    });
  };

  const set = (key: keyof Draft) => (event: { target: { value: string } }) => {
    setDraft((held) => (held === null ? held : { ...held, [key]: event.target.value }));
  };

  const card = {
    borderRadius: '10px',
    border: `1px solid ${tokens['border.default']}`,
    backgroundColor: tokens['bg.surface'],
  } as const;
  const header = {
    paddingBlock: 4,
    paddingInline: 5,
    borderBlockEnd: `1px solid ${tokens['border.default']}`,
  } as const;
  const busy = upload.isPending || remove.isPending;

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        gap: 5,
        maxInlineSize: 720,
      }}
    >
      <Box
        component="form"
        noValidate
        onSubmit={submit}
        aria-labelledby={`${id}-heading`}
        sx={{ ...card, display: 'flex', flexDirection: 'column' }}
      >
        <Box sx={header}>
          <Typography id={`${id}-heading`} variant="h3" component="h2" sx={{ fontSize: 16 }}>
            {t('me:profile.heading')}
          </Typography>
          <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: 13 }}>
            {t('me:profile.caption')}
          </Typography>
        </Box>

        <Box sx={{ padding: 5, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
            <Avatar
              src={profile.photo?.large}
              alt={profile.photo === null ? '' : t('me:profile.photoAlt')}
              sx={{
                width: 64,
                height: 64,
                fontSize: 20,
                fontWeight: 600,
                backgroundColor: tokens['action.primary'],
                color: tokens['action.primary.text'],
              }}
            >
              {splitName(profile.displayName).first.slice(0, 1).toUpperCase()}
            </Avatar>
            <Box
              sx={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minInlineSize: 0 }}
            >
              <Box sx={{ display: 'flex', gap: 2, alignItems: 'center' }}>
                <Button
                  variant="outlined"
                  startIcon={<Camera size={16} aria-hidden="true" />}
                  disabled={busy}
                  onClick={() => {
                    fileInput.current?.click();
                  }}
                >
                  {t('me:profile.photoUpload')}
                </Button>
                <Button
                  variant="text"
                  disabled={busy || profile.photo === null}
                  onClick={() => {
                    remove.mutate();
                  }}
                >
                  {t('me:profile.photoRemove')}
                </Button>
              </Box>
              <input
                ref={fileInput}
                type="file"
                hidden
                data-testid="profile-photo-input"
                accept={PROFILE_PHOTO_MIME_TYPES.join(',')}
                aria-label={t('me:profile.photoUpload')}
                onChange={(event) => {
                  choose(event.target.files?.[0]);
                }}
              />
              <Typography
                id={`${id}-photo-hint`}
                variant="caption"
                sx={{
                  color: photoProblem === null ? 'text.secondary' : tokens['status.danger.text'],
                }}
                role={photoProblem === null ? undefined : 'alert'}
              >
                {photoProblem === null
                  ? t('me:profile.photoHint')
                  : t(`me:profile.${photoProblem}`)}
              </Typography>
            </Box>
          </Box>

          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: 'repeat(2, minmax(0, 1fr))' },
              gap: 4,
              alignItems: 'start',
            }}
          >
            <Field id={`${id}-name`} label={t('me:profile.name')}>
              <TextField
                id={`${id}-name`}
                size="small"
                value={draft.name}
                onChange={set('name')}
                slotProps={{ htmlInput: { maxLength: 120, autoComplete: 'name' } }}
              />
            </Field>
            <Field
              id={`${id}-public`}
              label={t('me:profile.publicName')}
              hint={t('me:profile.publicNameHint')}
            >
              <TextField
                id={`${id}-public`}
                size="small"
                value={draft.publicName}
                placeholder={splitName(draft.name).first}
                onChange={set('publicName')}
                slotProps={{
                  htmlInput: {
                    maxLength: PUBLIC_NAME_MAX_LENGTH,
                    'aria-describedby': `${id}-public-hint`,
                  },
                }}
              />
            </Field>
            <Field id={`${id}-title-en`} label={t('me:profile.jobTitleEn')}>
              <TextField
                id={`${id}-title-en`}
                size="small"
                value={draft.jobTitleEn}
                onChange={set('jobTitleEn')}
                slotProps={{
                  htmlInput: { dir: 'ltr', lang: 'en', maxLength: JOB_TITLE_MAX_LENGTH },
                }}
              />
            </Field>
            <Field id={`${id}-title-ar`} label={t('me:profile.jobTitleAr')}>
              <TextField
                id={`${id}-title-ar`}
                size="small"
                value={draft.jobTitleAr}
                onChange={set('jobTitleAr')}
                slotProps={{
                  htmlInput: { dir: 'rtl', lang: 'ar', maxLength: JOB_TITLE_MAX_LENGTH },
                }}
              />
            </Field>
            <Field
              id={`${id}-phone`}
              label={t('me:profile.phone')}
              hint={t('me:profile.phoneHint', { placeholder: '{{agent.phone}}' })}
              error={phoneWrong ? t('me:profile.phoneInvalid') : undefined}
            >
              <TextField
                id={`${id}-phone`}
                size="small"
                type="tel"
                value={draft.phone}
                error={phoneWrong}
                onChange={set('phone')}
                slotProps={{
                  htmlInput: {
                    dir: 'ltr',
                    maxLength: PUBLIC_PHONE_MAX_LENGTH,
                    autoComplete: 'tel',
                    'aria-invalid': phoneWrong,
                    'aria-describedby': `${id}-phone-${phoneWrong ? 'error' : 'hint'}`,
                  },
                }}
              />
            </Field>
            <Box>
              <TimeZoneSelect
                label={t('me:profile.timeZone')}
                value={draft.timeZone}
                helperText={t('me:profile.timeZoneHint')}
                onChange={(timeZone) => {
                  setDraft((held) => (held === null ? held : { ...held, timeZone }));
                }}
              />
            </Box>
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
            borderEndStartRadius: '10px',
            borderEndEndRadius: '10px',
          }}
        >
          <Button
            variant="text"
            disabled={save.isPending}
            onClick={() => {
              setDraft(draftOf(profile));
              setPhoneWrong(false);
            }}
          >
            {t('me:profile.discard')}
          </Button>
          <Button type="submit" variant="contained" disabled={save.isPending}>
            {t('me:profile.save')}
          </Button>
        </Box>
      </Box>

      <Box component="section" aria-labelledby={`${id}-working`} sx={card}>
        <Box sx={header}>
          <Typography id={`${id}-working`} variant="h3" component="h2" sx={{ fontSize: 16 }}>
            {t('me:profile.workingHeading')}
          </Typography>
          <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: 13 }}>
            {t('me:profile.workingCaption')}
          </Typography>
        </Box>
        <Box sx={{ padding: 5, display: 'flex', alignItems: 'center', gap: 3 }}>
          <Switch
            checked={keyboard.singleKeys}
            label={t('me:profile.singleKeys')}
            describedBy={`${id}-keys-hint`}
            busy={keyboard.saving}
            onChange={keyboard.setSingleKeys}
          />
          <Box sx={{ display: 'flex', flexDirection: 'column' }}>
            <Typography variant="body2" component="span" sx={{ fontSize: 13, fontWeight: 500 }}>
              {t('me:profile.singleKeys')}
            </Typography>
            <Typography id={`${id}-keys-hint`} variant="caption" sx={{ color: 'text.secondary' }}>
              {t('me:profile.singleKeysHint')}
            </Typography>
          </Box>
        </Box>
      </Box>
    </Box>
  );
}
