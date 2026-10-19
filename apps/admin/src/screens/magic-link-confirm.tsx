import { Box, Button, CircularProgress, Link, Typography } from '@mui/material';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ChevronLeft, Mail } from 'lucide-react';
import { type FormEvent, type ReactNode, useId } from 'react';
import { Link as RouterLink, useLocation } from 'react-router';
import { useT } from '../app/i18n.js';
import { DEFAULT_SIGNED_IN_ROUTE, magicLinkTokenFromHash, ROUTES } from '../app/route-paths.js';
import { useSemanticTokens } from '../app/tokens.js';
import { isAuthError } from '../auth/api.js';
import { useAuthApi } from '../auth/session.tsx';
import { ssoErrorKey } from '../auth/sso-error.js';
import { AlertBanner } from '../ui/alert-banner.tsx';
import { AuthLayout, LanguageLink } from './auth-layout.tsx';
import { useFinishSignIn } from './finish-sign-in.js';

/**
 * `Admin/SignIn-MagicLink` and `-AR`: where a sign-in link opens (M9-01 F6).
 *
 * Opening the link spends nothing. The page reads the token from the fragment,
 * asks the api whose account it opens, and spends it only when the person
 * clicks Continue — so a mail scanner or a link preview that fetches the URL
 * leaves it working. What follows the click is what follows a password: the
 * session, the code screen, or enrolment.
 */

/**
 * Which sentence a refusal reads as. A dead link and a used one are the same
 * answer from the api, and the same sentence here; enforced SSO has its own.
 */
const refusalKey = (error: unknown) => {
  if (!isAuthError(error) || error.code === 'unavailable') return 'auth:unavailable';
  return ssoErrorKey(error.code) ?? 'auth:magicLinkConfirm.invalid';
};

/** A refusal that no second click can change: the link is gone or not allowed. */
const isFinal = (error: unknown): boolean =>
  isAuthError(error) && refusalKey(error) !== 'auth:unavailable';

export function MagicLinkConfirm(): ReactNode {
  const t = useT();
  const api = useAuthApi();
  const { hash } = useLocation();
  const token = magicLinkTokenFromHash(hash);
  const finishSignIn = useFinishSignIn(DEFAULT_SIGNED_IN_ROUTE);

  const preview = useQuery({
    queryKey: ['auth', 'magic-link', token],
    queryFn: () => api.previewMagicLink(token),
    enabled: token !== '',
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });

  const consume = useMutation({
    mutationFn: () => api.consumeMagicLink(token),
    onSuccess: finishSignIn,
  });

  const layout = {
    title: t('auth:magicLinkConfirm.title'),
    subtitle: t('auth:magicLinkConfirm.subtitle'),
  };

  if (token !== '' && preview.isPending) {
    return (
      <AuthLayout {...layout}>
        <Checking />
      </AuthLayout>
    );
  }

  const refusal =
    token === ''
      ? 'auth:magicLinkConfirm.invalid'
      : preview.isError
        ? refusalKey(preview.error)
        : isFinal(consume.error)
          ? refusalKey(consume.error)
          : null;

  if (refusal !== null || preview.data === undefined) {
    return <RefusedLink {...layout} message={t(refusal ?? 'auth:magicLinkConfirm.invalid')} />;
  }

  return (
    <ConfirmCard
      {...layout}
      email={preview.data.email}
      expiresInMinutes={preview.data.expiresInMinutes}
      pending={consume.isPending}
      failed={consume.isError}
      onContinue={() => {
        consume.mutate();
      }}
    />
  );
}

function Checking(): ReactNode {
  const t = useT();

  return (
    <Box
      role="status"
      sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 3 }}
    >
      <CircularProgress size={16} aria-hidden="true" />
      <Typography variant="body2" sx={{ color: 'text.secondary' }}>
        {t('common:loading')}
      </Typography>
    </Box>
  );
}

/** The expired-or-used state: why, and the one way out. */
function RefusedLink({
  title,
  subtitle,
  message,
}: {
  readonly title: string;
  readonly subtitle: string;
  readonly message: string;
}): ReactNode {
  const t = useT();

  return (
    <AuthLayout
      title={title}
      subtitle={subtitle}
      footer={
        <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
          <LanguageLink />
        </Box>
      }
    >
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <AlertBanner tone="danger">{message}</AlertBanner>
        <Button
          component={RouterLink}
          to={ROUTES.signIn}
          variant="outlined"
          color="secondary"
          fullWidth
          startIcon={
            <Box
              component="span"
              sx={{ display: 'inline-flex', '[dir="rtl"] &': { transform: 'scaleX(-1)' } }}
            >
              <ChevronLeft size={16} aria-hidden="true" />
            </Box>
          }
        >
          {t('auth:backToSignIn')}
        </Button>
      </Box>
    </AuthLayout>
  );
}

interface ConfirmCardProps {
  readonly title: string;
  readonly subtitle: string;
  readonly email: string;
  readonly expiresInMinutes: number;
  readonly pending: boolean;
  /** A click that failed for a reason another click might not: shown above the button. */
  readonly failed: boolean;
  readonly onContinue: () => void;
}

/** The valid-link state: whose account, one button, and what the link allows. */
function ConfirmCard({
  title,
  subtitle,
  email,
  expiresInMinutes,
  pending,
  failed,
  onContinue,
}: ConfirmCardProps): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const noteId = useId();

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    onContinue();
  };

  return (
    <AuthLayout
      title={title}
      subtitle={subtitle}
      footer={
        <Box
          sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 4 }}
        >
          <Link component={RouterLink} to={ROUTES.signIn} variant="caption">
            {t('auth:magicLinkConfirm.notYou')}
          </Link>
          <LanguageLink />
        </Box>
      }
    >
      <Box
        component="form"
        noValidate
        onSubmit={submit}
        sx={{ display: 'flex', flexDirection: 'column', gap: 4 }}
      >
        {failed ? <AlertBanner tone="danger">{t('auth:unavailable')}</AlertBanner> : null}

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 3 }}>
          <Box
            aria-hidden="true"
            sx={{
              width: 36,
              height: 36,
              flexShrink: 0,
              borderRadius: '999px',
              backgroundColor: tokens['action.primary.tint'],
              color: tokens['action.primary'],
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Mail size={18} aria-hidden="true" />
          </Box>
          <Box sx={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              {t('auth:magicLinkConfirm.signingInAs')}
            </Typography>
            <Typography variant="bodyStrong" sx={{ overflowWrap: 'anywhere' }}>
              <bdi>{email}</bdi>
            </Typography>
          </Box>
        </Box>

        <Button
          type="submit"
          variant="contained"
          color="primary"
          fullWidth
          loading={pending}
          aria-describedby={noteId}
        >
          {t('auth:magicLinkConfirm.continue')}
        </Button>

        <Typography id={noteId} variant="caption" sx={{ color: 'text.secondary' }}>
          {t('auth:magicLinkConfirm.note', { count: expiresInMinutes })}
        </Typography>
      </Box>
    </AuthLayout>
  );
}
