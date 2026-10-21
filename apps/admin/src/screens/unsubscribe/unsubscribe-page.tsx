import type { UnsubscribeView } from '@helpdock/schemas';
import type { SemanticTokens } from '@helpdock/ui';
import { Box, Button, Typography } from '@mui/material';
import { Check, TriangleAlert } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useT } from '../../app/i18n.js';
import { ROUTES } from '../../app/route-paths.js';
import type { LoadState } from './unsubscribe-app.tsx';

/**
 * What the unsubscribe page draws (`Public/Unsubscribe`, en and ar): the
 * confirmation, what is left once it is done, and one screen for a link that
 * is expired, altered or for nobody.
 *
 * - **One screen for every bad link.** Forged, expired, or for an account that
 *   is gone: the same words, and nothing that says whether an address exists.
 * - **Targets 44 px** and a single column that holds at 320 px wide.
 * - The address is wrapped in `<bdi>` so it reads left to right inside Arabic.
 */

const CARD_WIDTH = 480;
const EMAIL_SLOT = '\u0000';

export function UnsubscribePage({
  tokens,
  state,
  onUnsubscribe,
  onRetry,
}: {
  readonly tokens: SemanticTokens;
  readonly state: LoadState;
  onUnsubscribe(): Promise<UnsubscribeView>;
  onRetry(): void;
}): ReactNode {
  const t = useT();
  const [done, setDone] = useState<UnsubscribeView | null>(null);
  const view = done ?? (state.kind === 'ready' ? state.view : null);

  return (
    <Box
      component="main"
      sx={{
        minHeight: '100vh',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'flex-start',
        paddingBlock: { xs: 4, sm: 12 },
        paddingInline: 4,
        backgroundColor: tokens['bg.canvas'],
        fontSize: 14,
        lineHeight: '20px',
      }}
    >
      <Box
        sx={{
          width: '100%',
          maxWidth: CARD_WIDTH,
          boxSizing: 'border-box',
          padding: { xs: 5, sm: 8 },
          borderRadius: '10px',
          border: `1px solid ${tokens['border.default']}`,
          backgroundColor: tokens['bg.surface'],
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
        }}
      >
        <ProductMark tokens={tokens} />

        {state.kind === 'loading' ? (
          <Box aria-busy="true" role="status">
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>
              {t('unsubscribe:loading')}
            </Typography>
          </Box>
        ) : null}

        {state.kind === 'failed' && state.problem === 'not-found' ? <Invalid /> : null}

        {state.kind === 'failed' && state.problem === 'unavailable' ? (
          <Unavailable onRetry={onRetry} />
        ) : null}

        {view?.state === 'confirm' ? (
          <Confirm
            email={view.email ?? ''}
            onUnsubscribe={async () => {
              setDone(await onUnsubscribe());
            }}
          />
        ) : null}

        {view?.state === 'done' ? <Done tokens={tokens} /> : null}
      </Box>
    </Box>
  );
}

function ProductMark({ tokens }: { readonly tokens: SemanticTokens }): ReactNode {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
      <Box
        aria-hidden="true"
        sx={{
          width: 32,
          height: 32,
          borderRadius: '6px',
          display: 'grid',
          placeItems: 'center',
          fontWeight: 600,
          fontSize: 16,
          backgroundColor: tokens['action.primary'],
          color: tokens['action.primary.text'],
        }}
      >
        H
      </Box>
      <Typography component="span" sx={{ fontWeight: 600, fontSize: 16 }}>
        Helpdock
      </Typography>
    </Box>
  );
}

function Confirm({
  email,
  onUnsubscribe,
}: {
  readonly email: string;
  onUnsubscribe(): Promise<void>;
}): ReactNode {
  const t = useT();
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);
  // The address is set apart with `<bdi>` so it reads left to right inside Arabic;
  // the catalog sentence is split around it rather than given the address.
  const [before = '', after = ''] = t('unsubscribe:confirm.body', { email: EMAIL_SLOT }).split(
    EMAIL_SLOT,
  );

  const submit = async (): Promise<void> => {
    setSending(true);
    setFailed(false);
    try {
      await onUnsubscribe();
    } catch {
      setFailed(true);
      setSending(false);
    }
  };

  return (
    <Box
      component="form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      sx={{ display: 'flex', flexDirection: 'column', gap: 4 }}
    >
      <Typography variant="h1" component="h1" sx={{ textWrap: 'pretty' }}>
        {t('unsubscribe:confirm.heading')}
      </Typography>
      <Typography sx={{ color: 'text.secondary' }}>
        {before}
        <bdi dir="ltr">{email}</bdi>
        {after}
      </Typography>
      {failed ? (
        <Typography role="alert" variant="body2" sx={{ color: 'error.main' }}>
          {t('unsubscribe:failed')}
        </Typography>
      ) : null}
      <Button
        type="submit"
        variant="contained"
        disabled={sending}
        sx={{ height: 44, width: '100%' }}
      >
        {t('unsubscribe:confirm.action')}
      </Button>
    </Box>
  );
}

function Done({ tokens }: { readonly tokens: SemanticTokens }): ReactNode {
  const t = useT();

  return (
    <>
      <Box
        role="status"
        sx={{
          display: 'flex',
          gap: 2.5,
          padding: 3,
          borderRadius: '6px',
          backgroundColor: tokens['status.success.tint'],
          color: tokens['status.success.text'],
          fontSize: 13,
          lineHeight: '20px',
        }}
      >
        <Check size={16} aria-hidden="true" style={{ flexShrink: 0, marginBlockStart: 2 }} />
        <span>{t('unsubscribe:done.status')}</span>
      </Box>
      <Typography sx={{ color: 'text.secondary' }}>{t('unsubscribe:done.body')}</Typography>
      <Box
        component="a"
        href={ROUTES.meNotifications}
        sx={{
          color: tokens['text.link'],
          fontSize: 14,
          minHeight: 44,
          display: 'inline-flex',
          alignItems: 'center',
        }}
      >
        {t('unsubscribe:done.settings')}
      </Box>
    </>
  );
}

function Invalid(): ReactNode {
  const t = useT();

  return (
    <>
      <Typography variant="h1" component="h1" sx={{ textWrap: 'pretty' }}>
        {t('unsubscribe:invalid.heading')}
      </Typography>
      <Typography sx={{ color: 'text.secondary' }}>{t('unsubscribe:invalid.body')}</Typography>
      <Button
        component="a"
        href={ROUTES.signIn}
        variant="contained"
        sx={{ height: 44, width: '100%' }}
      >
        {t('unsubscribe:invalid.action')}
      </Button>
    </>
  );
}

function Unavailable({ onRetry }: { readonly onRetry: () => void }): ReactNode {
  const t = useT();

  return (
    <>
      <Typography
        variant="h1"
        component="h1"
        sx={{ display: 'flex', gap: 2, alignItems: 'center', textWrap: 'pretty' }}
      >
        <TriangleAlert size={20} aria-hidden="true" />
        {t('unsubscribe:unavailable.heading')}
      </Typography>
      <Typography sx={{ color: 'text.secondary' }}>{t('unsubscribe:unavailable.body')}</Typography>
      <Button variant="outlined" onClick={onRetry} sx={{ height: 44, width: '100%' }}>
        {t('unsubscribe:unavailable.retry')}
      </Button>
    </>
  );
}
