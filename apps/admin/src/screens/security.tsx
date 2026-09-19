import type { Locale } from '@helpdock/i18n';
import { SUPPORTED_LNGS } from '@helpdock/i18n';
import { PASSWORD_MIN_LENGTH, totpCodeRequestSchema } from '@helpdock/schemas';
import { Box, Button, Chip, MenuItem, Paper, TextField, Typography } from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useId, useState } from 'react';
import { useNavigate } from 'react-router';
import { useT } from '../app/i18n.js';
import { usePreferences } from '../app/providers.tsx';
import { ROUTES } from '../app/route-paths.js';
import { useSemanticTokens } from '../app/tokens.js';
import { isAuthError } from '../auth/api.js';
import { useAuthApi, useSetSession, useStaffApi } from '../auth/session.tsx';
import { PageHeader } from '../shell/page-header.tsx';
import { ConfirmDialog } from '../ui/confirm-dialog.tsx';
import { passwordStrength } from '../ui/password-strength.js';
import { PasswordStrengthBar } from '../ui/password-strength-bar.tsx';
import { useToast } from '../ui/toasts.tsx';

/**
 * `/me/security`: a person's own account.
 *
 * It reuses the `Admin/Settings` artboard's layout — a page header, then one
 * bordered card per area with its own title, caption and fields — rather than
 * inventing a shape for four unrelated things. Nothing here is new to DESIGN
 * §6: it is `Paper` on `bg.surface`, the `Field` label rules of §6.1, and the
 * confirmation dialog of §6.4.
 *
 * The three actions that weaken a credential each ask for one: a password
 * change asks for the current password, and turning the second factor off or
 * redrawing the recovery codes asks for a live code. A session proves somebody
 * signed in, not that the person at the keyboard now is the account holder.
 */

type Confirming = 'disable' | 'regenerate' | null;

function Card({
  title,
  caption,
  children,
}: {
  readonly title: string;
  readonly caption: string;
  readonly children: ReactNode;
}): ReactNode {
  const tokens = useSemanticTokens();

  return (
    <Paper
      elevation={0}
      component="section"
      sx={{
        padding: 6,
        borderRadius: '10px',
        border: `1px solid ${tokens['border.default']}`,
        backgroundColor: tokens['bg.surface'],
        display: 'flex',
        flexDirection: 'column',
        gap: 5,
      }}
    >
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        <Typography variant="h3" component="h2">
          {title}
        </Typography>
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          {caption}
        </Typography>
      </Box>
      {children}
    </Paper>
  );
}

export function SecurityScreen(): ReactNode {
  const t = useT();
  const api = useStaffApi();
  const authApi = useAuthApi();
  const toast = useToast();
  const navigate = useNavigate();
  const setSession = useSetSession();
  const queryClient = useQueryClient();
  const { setLocale } = usePreferences();

  const nameId = useId();
  const localeId = useId();
  const currentId = useId();
  const newPasswordId = useId();
  const codeId = useId();

  const [name, setName] = useState<string | null>(null);
  const [locale, setChosenLocale] = useState<Locale | null>(null);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<Confirming>(null);
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [newCodes, setNewCodes] = useState<readonly string[] | null>(null);

  const profile = useQuery({ queryKey: ['me', 'profile'], queryFn: () => api.profile() });
  const sessions = useQuery({ queryKey: ['me', 'sessions'], queryFn: () => api.sessions() });

  /** Both step-up dialogs answer a wrong code the same way, in the same field. */
  const reportCodeFailure = (error: unknown): void => {
    setCodeError(
      isAuthError(error) && error.code === 'totp-mismatch'
        ? t('me:twoFactor.codeWrong')
        : t('me:security.failed'),
    );
  };

  const fail = (error: unknown): void => {
    toast({
      tone: 'danger',
      message: isAuthError(error) ? t('auth:unavailable') : t('me:security.failed'),
    });
  };

  const saveProfile = useMutation({
    mutationFn: () =>
      api.updateProfile({
        ...(name === null ? {} : { name: name.trim() }),
        ...(locale === null ? {} : { locale }),
      }),
    onSuccess: async (updated) => {
      setLocale(updated.locale);
      setName(null);
      setChosenLocale(null);
      await queryClient.invalidateQueries({ queryKey: ['me', 'profile'] });
      toast({ tone: 'success', message: t('me:security.saved') });
    },
    onError: fail,
  });

  const changePassword = useMutation({
    mutationFn: () => api.changePassword(currentPassword, newPassword),
    onSuccess: async () => {
      setCurrentPassword('');
      setNewPassword('');
      setPasswordError(null);
      await queryClient.invalidateQueries({ queryKey: ['me', 'sessions'] });
      toast({ tone: 'success', message: t('me:password.done') });
    },
    onError: (error) => {
      if (isAuthError(error) && error.code === 'invalid-credentials') {
        setPasswordError(t('me:password.wrong'));
        return;
      }
      fail(error);
    },
  });

  const disableTotp = useMutation({
    mutationFn: () => api.disableTotp(code),
    onSuccess: async () => {
      setConfirming(null);
      setCode('');
      await queryClient.invalidateQueries({ queryKey: ['me', 'profile'] });
      toast({ tone: 'success', message: t('me:twoFactor.disabled') });
    },
    onError: reportCodeFailure,
  });

  const regenerate = useMutation({
    mutationFn: () => api.regenerateRecoveryCodes(code),
    onSuccess: async (result) => {
      setConfirming(null);
      setCode('');
      setNewCodes(result.recoveryCodes);
      await queryClient.invalidateQueries({ queryKey: ['me', 'profile'] });
      toast({ tone: 'success', message: t('me:twoFactor.regenerated') });
    },
    onError: reportCodeFailure,
  });

  const revokeSession = useMutation({
    mutationFn: (familyId: string) => api.revokeSession(familyId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['me', 'sessions'] });
      toast({ tone: 'success', message: t('me:sessions.signedOut') });
    },
    onError: fail,
  });

  const signOutEverywhere = useMutation({
    mutationFn: () => authApi.signOutEverywhere(),
    onSettled: () => {
      setSession(null);
      void navigate(ROUTES.signIn, { replace: true });
    },
  });

  const strength = passwordStrength(newPassword);
  const displayName = name ?? profile.data?.name ?? '';
  const displayLocale = locale ?? profile.data?.locale ?? 'en';

  const submitPassword = (event: FormEvent): void => {
    event.preventDefault();

    if (currentPassword === '') {
      setPasswordError(t('me:password.currentRequired'));
      return;
    }
    if (newPassword.length < PASSWORD_MIN_LENGTH) {
      setPasswordError(t('me:password.tooShort', { count: PASSWORD_MIN_LENGTH }));
      return;
    }

    setPasswordError(null);
    changePassword.mutate();
  };

  return (
    <>
      <PageHeader title={t('me:security.title')} caption={t('me:security.caption')} />

      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 6, maxWidth: 720 }}>
        <Card title={t('me:details.title')} caption={t('me:details.caption')}>
          <Box
            component="form"
            onSubmit={(event) => {
              event.preventDefault();
              saveProfile.mutate();
            }}
            sx={{ display: 'flex', flexDirection: 'column', gap: 5 }}
          >
            <TextField
              id={nameId}
              label={t('me:details.nameLabel')}
              value={displayName}
              onChange={(event) => {
                setName(event.target.value);
              }}
              slotProps={{ htmlInput: { maxLength: 120, autoComplete: 'name' } }}
            />
            {/*
              Read-only rather than disabled: a disabled control's text and its
              hint are drawn in the disabled colour, which is below the 4.5:1
              of DESIGN §10, and an address somebody may want to copy should
              stay selectable.
            */}
            <TextField
              label={t('me:details.emailLabel')}
              value={profile.data?.email ?? ''}
              helperText={t('me:details.emailHint')}
              slotProps={{ input: { readOnly: true } }}
            />
            <TextField
              id={localeId}
              select
              label={t('me:details.localeLabel')}
              value={displayLocale}
              onChange={(event) => {
                setChosenLocale(event.target.value as Locale);
              }}
            >
              {SUPPORTED_LNGS.map((option) => (
                <MenuItem key={option} value={option} lang={option}>
                  {t(`common:language.${option}`)}
                </MenuItem>
              ))}
            </TextField>
            <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
              <Button type="submit" variant="contained" disabled={saveProfile.isPending}>
                {t('me:details.submit')}
              </Button>
            </Box>
          </Box>
        </Card>

        <Card title={t('me:password.title')} caption={t('me:password.caption')}>
          <Box
            component="form"
            onSubmit={submitPassword}
            sx={{ display: 'flex', flexDirection: 'column', gap: 5 }}
          >
            <TextField
              id={currentId}
              type="password"
              label={t('me:password.currentLabel')}
              value={currentPassword}
              onChange={(event) => {
                setCurrentPassword(event.target.value);
              }}
              error={passwordError !== null}
              helperText={passwordError ?? ' '}
              slotProps={{ htmlInput: { autoComplete: 'current-password' } }}
            />
            <Box>
              <TextField
                id={newPasswordId}
                type="password"
                label={t('me:password.newLabel')}
                value={newPassword}
                onChange={(event) => {
                  setNewPassword(event.target.value);
                }}
                helperText={t('me:password.newHint', {
                  count: PASSWORD_MIN_LENGTH,
                  strength: t(`auth:invite.strength.${strength.level}`),
                })}
                fullWidth
                slotProps={{ htmlInput: { autoComplete: 'new-password', maxLength: 200 } }}
              />
              <PasswordStrengthBar strength={strength} />
            </Box>
            <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
              <Button type="submit" variant="contained" disabled={changePassword.isPending}>
                {t('me:password.submit')}
              </Button>
            </Box>
          </Box>
        </Card>

        <Card
          title={t('me:twoFactor.title')}
          caption={
            profile.data?.twoFactorRequired === true
              ? t('me:twoFactor.requiredCaption')
              : profile.data?.twoFactorEnabled === true
                ? t('me:twoFactor.onCaption')
                : t('me:twoFactor.offCaption')
          }
        >
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 3, flexWrap: 'wrap' }}>
            <Chip
              size="small"
              color={profile.data?.twoFactorEnabled === true ? 'success' : 'default'}
              label={
                profile.data?.twoFactorEnabled === true
                  ? t('me:twoFactor.on')
                  : t('me:twoFactor.off')
              }
            />
            {profile.data?.twoFactorEnabled === true ? (
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                {t('me:twoFactor.codesLeft', { count: profile.data.recoveryCodesLeft })}
              </Typography>
            ) : null}
          </Box>

          <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
            {profile.data?.twoFactorEnabled === true ? (
              <>
                <Button
                  variant="outlined"
                  onClick={() => {
                    setCode('');
                    setCodeError(null);
                    setConfirming('regenerate');
                  }}
                >
                  {t('me:twoFactor.regenerate')}
                </Button>
                {profile.data.twoFactorRequired ? null : (
                  <Button
                    variant="outlined"
                    color="error"
                    onClick={() => {
                      setCode('');
                      setCodeError(null);
                      setConfirming('disable');
                    }}
                  >
                    {t('me:twoFactor.disable')}
                  </Button>
                )}
              </>
            ) : (
              <Button
                variant="contained"
                onClick={() => {
                  void navigate(ROUTES.totpEnrolment);
                }}
              >
                {t('me:twoFactor.enable')}
              </Button>
            )}
          </Box>

          {newCodes === null ? null : (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <Typography variant="bodyStrong" component="p">
                {t('me:twoFactor.newCodesTitle')}
              </Typography>
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                {t('me:twoFactor.newCodesBody')}
              </Typography>
              <Box
                component="ul"
                aria-label={t('auth:enrolment.step2.listLabel')}
                sx={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(2, 1fr)',
                  gap: 1,
                  margin: 0,
                  padding: 0,
                  listStyle: 'none',
                  fontFamily: 'var(--hd-font-mono, monospace)',
                }}
              >
                {newCodes.map((recoveryCode) => (
                  <Typography
                    key={recoveryCode}
                    component="li"
                    variant="body2"
                    sx={{ fontFamily: 'inherit' }}
                  >
                    <bdi>{recoveryCode}</bdi>
                  </Typography>
                ))}
              </Box>
            </Box>
          )}
        </Card>

        <Card title={t('me:sessions.title')} caption={t('me:sessions.caption')}>
          <Box
            component="ul"
            aria-label={t('me:sessions.listLabel')}
            sx={{
              margin: 0,
              padding: 0,
              listStyle: 'none',
              display: 'flex',
              flexDirection: 'column',
              gap: 3,
            }}
          >
            {(sessions.data?.sessions ?? []).map((item) => (
              <Box
                key={item.familyId}
                component="li"
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 4,
                }}
              >
                <Box sx={{ minWidth: 0 }}>
                  <Typography variant="bodyStrong" component="span" sx={{ display: 'block' }}>
                    <bdi>
                      {item.userAgent === '' ? t('me:sessions.unknownBrowser') : item.userAgent}
                    </bdi>
                    {item.current ? ` · ${t('me:sessions.current')}` : ''}
                  </Typography>
                  <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                    {t('me:sessions.lastUsedAt', {
                      date: new Date(item.lastUsedAt).toLocaleString(),
                    })}
                  </Typography>
                </Box>
                <Button
                  variant="text"
                  aria-label={t('me:sessions.signOutLabel', {
                    browser:
                      item.userAgent === '' ? t('me:sessions.unknownBrowser') : item.userAgent,
                  })}
                  disabled={revokeSession.isPending}
                  onClick={() => {
                    revokeSession.mutate(item.familyId);
                  }}
                >
                  {t('me:sessions.signOut')}
                </Button>
              </Box>
            ))}
          </Box>

          <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button
              variant="outlined"
              color="error"
              onClick={() => {
                signOutEverywhere.mutate();
              }}
            >
              {t('me:sessions.signOutEverywhere')}
            </Button>
          </Box>
        </Card>
      </Box>

      <ConfirmDialog
        open={confirming !== null}
        destructive={confirming === 'disable'}
        busy={disableTotp.isPending || regenerate.isPending}
        title={
          confirming === 'disable'
            ? t('me:twoFactor.disableTitle')
            : t('me:twoFactor.regenerateTitle')
        }
        body={
          confirming === 'disable'
            ? t('me:twoFactor.disableBody')
            : t('me:twoFactor.regenerateBody')
        }
        confirmLabel={
          confirming === 'disable'
            ? t('me:twoFactor.disableSubmit')
            : t('me:twoFactor.regenerateSubmit')
        }
        onClose={() => {
          setConfirming(null);
        }}
        onConfirm={() => {
          if (!totpCodeRequestSchema.shape.code.safeParse(code).success) {
            setCodeError(t('me:twoFactor.codeRequired'));
            return;
          }

          setCodeError(null);
          if (confirming === 'disable') {
            disableTotp.mutate();
          } else {
            regenerate.mutate();
          }
        }}
      >
        <TextField
          id={codeId}
          label={t('me:twoFactor.codeLabel')}
          value={code}
          onChange={(event) => {
            setCode(event.target.value.replace(/\D/g, '').slice(0, 6));
          }}
          error={codeError !== null}
          helperText={codeError ?? ' '}
          fullWidth
          slotProps={{
            htmlInput: {
              inputMode: 'numeric',
              autoComplete: 'one-time-code',
              maxLength: 6,
              style: { fontFamily: 'var(--hd-font-mono, monospace)' },
            },
          }}
        />
      </ConfirmDialog>
    </>
  );
}
