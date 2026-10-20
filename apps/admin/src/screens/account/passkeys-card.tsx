import type { Passkey, PasskeyList, PasskeyProof, RegistrationResponse } from '@helpdock/schemas';
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  TextField,
  Typography,
} from '@mui/material';
import { WebAuthnAbortService } from '@simplewebauthn/browser';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Cloud, Info, KeyRound } from 'lucide-react';
import { type Dispatch, type ReactNode, type SetStateAction, useId, useState } from 'react';
import { useT } from '../../app/i18n.js';
import { usePreferences } from '../../app/providers.tsx';
import { useSemanticTokens } from '../../app/tokens.js';
import { isAuthError } from '../../auth/api.js';
import {
  assertPasskey,
  createPasskey,
  isPasskeyCeremonyError,
  type PasskeyCeremonyFailure,
  passkeysSupported,
} from '../../auth/passkey-ceremony.js';
import { useAuthApi } from '../../auth/session.tsx';
import { EmptyState } from '../../shell/empty-state.tsx';
import { AlertBanner } from '../../ui/alert-banner.tsx';
import { ConfirmDialog } from '../../ui/confirm-dialog.tsx';
import { formatDay } from '../../ui/format.js';
import { useToast } from '../../ui/toasts.tsx';
import { Pill } from '../tickets/badges.tsx';
import { AccountCard } from './account-card.tsx';

/**
 * Passkeys on `/me/security` (M18-02, artboard `Admin/Profile-Security-Passkeys`):
 * one row per passkey with Rename and Remove, and Add in the header. Each of the
 * three asks "Confirm it's you" first (the passkey itself, the password or a
 * live code) and only then shows its own dialog; the api checks the proof with
 * the change, so a wrong password is said at the step it belongs to.
 *
 * The card is drawn only where passkeys can exist: not when `APP_URL` is not a
 * secure context. When the install's address moved, adding is off and removing
 * still works, so nobody is stuck with passkeys that cannot sign.
 */

const PASSKEYS_KEY = ['me', 'passkeys'] as const;

/** A password is at least twelve characters, so six digits can only be a code. */
const secretProof = (value: string): PasskeyProof =>
  /^\d{6}$/.test(value) ? { code: value } : { currentPassword: value };

type Flow =
  | { readonly kind: 'add'; readonly step: 'stepUp' }
  | {
      readonly kind: 'add';
      readonly step: 'prompt';
      readonly ceremonyId: string;
      readonly options: Readonly<Record<string, unknown>>;
      readonly failure: PasskeyCeremonyFailure | null;
    }
  | {
      readonly kind: 'add';
      readonly step: 'name';
      readonly ceremonyId: string;
      readonly response: RegistrationResponse;
    }
  | {
      readonly kind: 'rename' | 'remove';
      readonly passkey: Passkey;
      readonly step: 'stepUp' | 'action';
      readonly proof: PasskeyProof | null;
    }
  | { readonly kind: 'limit' };

export function PasskeysCard({
  onRecoveryCodes,
}: {
  /** The recovery codes drawn with the account's first second factor, shown once by the page. */
  readonly onRecoveryCodes?: (codes: readonly string[]) => void;
} = {}): ReactNode {
  const t = useT();
  const api = useAuthApi();
  const [flow, setFlow] = useState<Flow | null>(null);
  const supported = passkeysSupported();
  const query = useQuery({ queryKey: PASSKEYS_KEY, queryFn: () => api.passkeys() });
  const list = query.data;

  if (list === undefined || list.state === 'unavailable') {
    return null;
  }

  const startAdd = (): void => {
    setFlow(
      list.passkeys.length >= list.limit ? { kind: 'limit' } : { kind: 'add', step: 'stepUp' },
    );
  };

  return (
    <AccountCard title={t('me:passkeys.title')} caption={t('me:passkeys.caption')}>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        {list.state === 'paused' ? (
          <AlertBanner tone="warning">{t('me:passkeys.paused')}</AlertBanner>
        ) : null}
        {supported ? null : <AlertBanner tone="info">{t('me:passkeys.unsupported')}</AlertBanner>}
        <Box>
          <Button
            variant="contained"
            startIcon={<KeyRound size={16} aria-hidden="true" />}
            disabled={list.state === 'paused' || !supported}
            onClick={startAdd}
          >
            {t('me:passkeys.add')}
          </Button>
        </Box>
      </Box>
      <PasskeyRows
        list={list}
        onRename={(passkey) => {
          setFlow({ kind: 'rename', passkey, step: 'stepUp', proof: null });
        }}
        onRemove={(passkey) => {
          setFlow({ kind: 'remove', passkey, step: 'stepUp', proof: null });
        }}
      />
      <Typography variant="caption" sx={{ color: 'text.secondary' }}>
        {list.passkeys.length === 0
          ? t('me:passkeys.footer')
          : `${t('me:passkeys.usage', { count: list.passkeys.length, max: list.limit })} ${t('me:passkeys.footer')}`}
      </Typography>
      <PasskeyFlow
        list={list}
        flow={flow}
        setFlow={setFlow}
        onClose={() => {
          setFlow(null);
        }}
        {...(onRecoveryCodes === undefined ? {} : { onRecoveryCodes })}
      />
    </AccountCard>
  );
}

function PasskeyRows({
  list,
  onRename,
  onRemove,
}: {
  readonly list: PasskeyList;
  onRename(passkey: Passkey): void;
  onRemove(passkey: Passkey): void;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const { locale } = usePreferences();
  const blockedId = useId();

  if (list.passkeys.length === 0) {
    return (
      <EmptyState
        icon={KeyRound}
        heading={t('me:passkeys.emptyTitle')}
        body={t('me:passkeys.emptyBody')}
      />
    );
  }

  return (
    <>
      <Box component="ul" sx={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {list.passkeys.map((passkey) => (
          <Box
            component="li"
            key={passkey.id}
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 3,
              minHeight: 56,
              paddingBlock: 2,
              borderBlockStart: `1px solid ${tokens['bg.muted']}`,
            }}
          >
            <Box
              component="span"
              sx={{
                width: 32,
                height: 32,
                flexShrink: 0,
                borderRadius: '6px',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: tokens['bg.muted'],
                color: tokens['text.primary'],
              }}
            >
              <KeyRound size={16} aria-hidden="true" />
            </Box>
            <Box sx={{ flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
              <Typography
                variant="bodyStrong"
                component="span"
                sx={{ display: 'flex', alignItems: 'center', gap: 2 }}
              >
                <bdi>{passkey.name}</bdi>
                {passkey.synced ? (
                  <Pill tone="neutral" icon={<Cloud size={12} aria-hidden="true" />}>
                    {t('me:passkeys.synced')}
                  </Pill>
                ) : null}
              </Typography>
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                {t('me:passkeys.addedOn', { date: formatDay(passkey.createdAt, locale) })}
                {' · '}
                {passkey.lastUsedAt === null
                  ? t('me:passkeys.neverUsed')
                  : t('me:passkeys.lastUsed', { date: formatDay(passkey.lastUsedAt, locale) })}
              </Typography>
            </Box>
            <Button
              variant="text"
              aria-label={t('me:passkeys.renameLabel', { name: passkey.name })}
              sx={{ flexShrink: 0 }}
              onClick={() => {
                onRename(passkey);
              }}
            >
              {t('me:passkeys.rename')}
            </Button>
            <Button
              variant="outlined"
              disabled={list.removalBlocked}
              aria-label={t('me:passkeys.removeLabel', { name: passkey.name })}
              aria-describedby={list.removalBlocked ? blockedId : undefined}
              sx={{ flexShrink: 0 }}
              onClick={() => {
                onRemove(passkey);
              }}
            >
              {t('me:passkeys.remove')}
            </Button>
          </Box>
        ))}
      </Box>
      {list.removalBlocked ? (
        <Typography
          id={blockedId}
          variant="caption"
          sx={{ color: 'text.secondary', display: 'flex', alignItems: 'center', gap: 2 }}
        >
          <Info size={14} aria-hidden="true" style={{ flexShrink: 0 }} />
          {t('me:passkeys.lastFactor')}
        </Typography>
      ) : null}
    </>
  );
}

type FlowProps = {
  readonly list: PasskeyList;
  readonly flow: Flow | null;
  setFlow: Dispatch<SetStateAction<Flow | null>>;
  onClose(): void;
  readonly onRecoveryCodes?: (codes: readonly string[]) => void;
};

/** Which dialog the current step of the current flow shows. */
function PasskeyFlow({ list, flow, setFlow, onClose, onRecoveryCodes }: FlowProps): ReactNode {
  const t = useT();
  const api = useAuthApi();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const finish = async (message: string): Promise<void> => {
    onClose();
    setError(null);
    await queryClient.invalidateQueries({ queryKey: PASSKEYS_KEY });
    toast({ tone: 'success', message });
  };

  /** What a refused step-up looks like to the person: said in the field, not as a failure. */
  const proofError = (failure: unknown): string | null => {
    if (!isAuthError(failure)) return null;
    if (failure.code === 'totp-locked') return t('me:passkeys.locked');
    if (failure.code === 'challenge-expired') return t('me:passkeys.passkeyProofFailed');
    if (failure.code === 'invalid-credentials' || failure.code === 'totp-mismatch') {
      return t('me:passkeys.proofWrong');
    }
    return null;
  };

  const fail = (failure: unknown): void => {
    if (isAuthError(failure) && failure.code === 'passkey-limit') {
      setFlow({ kind: 'limit' });
      return;
    }
    onClose();
    setError(null);
    toast({
      tone: 'danger',
      message:
        isAuthError(failure) && failure.code === 'passkey-duplicate'
          ? t('me:passkeys.duplicate')
          : isAuthError(failure) && failure.code === 'second-factor-required'
            ? t('me:passkeys.removeBlocked')
            : isAuthError(failure) && failure.code === 'challenge-expired'
              ? t('me:passkeys.expired')
              : t('me:passkeys.failed'),
    });
  };

  const begin = useMutation({
    mutationFn: (proof: PasskeyProof) => api.beginPasskey(proof),
    onSuccess: ({ ceremonyId, options }) => {
      setError(null);
      setFlow({ kind: 'add', step: 'prompt', ceremonyId, options, failure: null });
      prompt.mutate({ ceremonyId, options });
    },
    onError: (failure) => {
      const said = proofError(failure);
      if (said === null) fail(failure);
      else setError(said);
    },
  });

  const prompt = useMutation({
    mutationFn: ({ options }: { ceremonyId: string; options: Readonly<Record<string, unknown>> }) =>
      createPasskey(options),
    onSuccess: (response, { ceremonyId }) => {
      setFlow({ kind: 'add', step: 'name', ceremonyId, response });
    },
    onError: (failure, { ceremonyId, options }) => {
      const reason = isPasskeyCeremonyError(failure) ? failure.reason : 'failed';
      // A dialog closed with Cancel aborts the ceremony; its rejection must not reopen it.
      setFlow((current) =>
        current?.kind === 'add' && current.step === 'prompt'
          ? { kind: 'add', step: 'prompt', ceremonyId, options, failure: reason }
          : current,
      );
    },
  });

  const store = useMutation({
    mutationFn: (request: { ceremonyId: string; response: RegistrationResponse; name: string }) =>
      api.finishPasskey(request),
    onSuccess: (added) => {
      if (added.recoveryCodes !== undefined) {
        onRecoveryCodes?.(added.recoveryCodes);
      }
      finish(t('me:passkeys.addedToast'));
    },
    onError: fail,
  });

  const change = useMutation({
    mutationFn: async (input: {
      kind: 'rename' | 'remove';
      passkey: Passkey;
      proof: PasskeyProof;
      name: string;
    }) => {
      if (input.kind === 'rename') {
        await api.renamePasskey(input.passkey.id, input.name, input.proof);
      } else {
        await api.removePasskey(input.passkey.id, input.proof);
      }
    },
    onSuccess: (_nothing, { kind }) =>
      finish(kind === 'rename' ? t('me:passkeys.renamedToast') : t('me:passkeys.removedToast')),
    onError: (failure, { kind, passkey }) => {
      const said = proofError(failure);
      if (said === null) {
        fail(failure);
        return;
      }
      setError(said);
      setFlow({ kind, passkey, step: 'stepUp', proof: null });
    },
  });

  const close = (): void => {
    WebAuthnAbortService.cancelCeremony();
    setError(null);
    onClose();
  };

  if (flow === null) {
    return null;
  }

  if (flow.kind === 'limit') {
    return (
      <Dialog
        open
        onClose={close}
        maxWidth="xs"
        fullWidth
        slotProps={{ paper: { sx: { maxWidth: 480, borderRadius: '10px' } } }}
      >
        <DialogTitle sx={{ fontSize: 16, fontWeight: 600 }}>
          {t('me:passkeys.limitTitle', { max: list.limit })}
        </DialogTitle>
        <DialogContent>
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            {t('me:passkeys.limitBody')}
          </Typography>
        </DialogContent>
        <DialogActions sx={{ padding: 4 }}>
          <Button variant="contained" onClick={close}>
            {t('me:passkeys.close')}
          </Button>
        </DialogActions>
      </Dialog>
    );
  }

  if (flow.kind === 'add' && flow.step === 'prompt') {
    return (
      <PromptDialog
        failure={flow.failure}
        busy={prompt.isPending}
        onRetry={() => {
          setFlow({ ...flow, failure: null });
          prompt.mutate({ ceremonyId: flow.ceremonyId, options: flow.options });
        }}
        onClose={close}
      />
    );
  }

  if (flow.kind === 'add' && flow.step === 'name') {
    return (
      <NameDialog
        title={t('me:passkeys.nameTitle')}
        body={t('me:passkeys.nameBody')}
        initial={t('me:passkeys.nameDefault', { number: list.passkeys.length + 1 })}
        busy={store.isPending}
        onSave={(name) => {
          store.mutate({ ceremonyId: flow.ceremonyId, response: flow.response, name });
        }}
        onClose={close}
      />
    );
  }

  if (flow.kind === 'rename' && flow.step === 'action' && flow.proof !== null) {
    const { proof, passkey } = flow;
    return (
      <NameDialog
        title={t('me:passkeys.renameTitle')}
        body={t('me:passkeys.renameBody')}
        initial={passkey.name}
        busy={change.isPending}
        onSave={(name) => {
          change.mutate({ kind: 'rename', passkey, proof, name });
        }}
        onClose={close}
      />
    );
  }

  if (flow.kind === 'remove' && flow.step === 'action' && flow.proof !== null) {
    const { proof, passkey } = flow;
    return (
      <ConfirmDialog
        open
        destructive
        busy={change.isPending}
        title={t('me:passkeys.removeTitle', { name: passkey.name })}
        body={t('me:passkeys.removeBody')}
        confirmLabel={t('me:passkeys.removeConfirm')}
        onClose={close}
        onConfirm={() => {
          change.mutate({ kind: 'remove', passkey, proof, name: '' });
        }}
      >
        <RemainingNote list={list} />
      </ConfirmDialog>
    );
  }

  const body =
    flow.kind === 'add'
      ? t('me:passkeys.stepUpAdd')
      : flow.kind === 'rename'
        ? t('me:passkeys.stepUpRename', { name: flow.passkey.name })
        : t('me:passkeys.stepUpRemove', { name: flow.passkey.name });

  return (
    <StepUpDialog
      body={body}
      hasPasskeys={list.passkeys.length > 0}
      busy={begin.isPending}
      error={error}
      onClose={close}
      onProof={(proof) => {
        setError(null);
        if (flow.kind === 'add') {
          begin.mutate(proof);
        } else {
          setFlow({ ...flow, step: 'action', proof });
        }
      }}
    />
  );
}

/** What still protects the account once this passkey is gone. */
function RemainingNote({ list }: { readonly list: PasskeyList }): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const left = list.passkeys.length - 1;
  const text =
    left > 0 && list.authenticatorApp
      ? t('me:passkeys.remainingBoth', { count: left })
      : left > 0
        ? t('me:passkeys.remainingPasskeys', { count: left })
        : list.authenticatorApp
          ? t('me:passkeys.remainingApp')
          : null;
  if (text === null) {
    return null;
  }

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        padding: '10px 12px',
        borderRadius: '6px',
        backgroundColor: tokens['bg.muted'],
      }}
    >
      <Info size={16} aria-hidden="true" style={{ flexShrink: 0 }} />
      <Typography variant="body2">{text}</Typography>
    </Box>
  );
}

/**
 * "Confirm it's you": the passkey button, then the password or a code in one
 * field. The passkey answers at once (the browser prompt is the confirmation);
 * the field's value goes on with Continue.
 */
function StepUpDialog({
  body,
  hasPasskeys,
  busy,
  error,
  onProof,
  onClose,
}: {
  readonly body: string;
  readonly hasPasskeys: boolean;
  readonly busy: boolean;
  readonly error: string | null;
  onProof(proof: PasskeyProof): void;
  onClose(): void;
}): ReactNode {
  const t = useT();
  const api = useAuthApi();
  const fieldId = useId();
  const [value, setValue] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const shown = problem ?? error;

  const confirmWithPasskey = async (): Promise<void> => {
    setAsking(true);
    setProblem(null);
    try {
      const { ceremonyId, options } = await api.passkeyStepUpOptions();
      const response = await assertPasskey(options);
      onProof({ passkey: { ceremonyId, response } });
    } catch (failure) {
      const cancelled = isPasskeyCeremonyError(failure) && failure.reason === 'cancelled';
      if (!cancelled) setProblem(t('me:passkeys.passkeyProofFailed'));
    } finally {
      setAsking(false);
    }
  };

  return (
    <ConfirmDialog
      open
      busy={busy || asking}
      title={t('me:passkeys.stepUpTitle')}
      body={body}
      confirmLabel={t('me:passkeys.continue')}
      onClose={onClose}
      onConfirm={() => {
        if (value === '') {
          setProblem(t('me:passkeys.proofRequired'));
          return;
        }
        setProblem(null);
        onProof(secretProof(value));
      }}
    >
      {hasPasskeys && passkeysSupported() ? (
        <>
          <Button
            variant="outlined"
            startIcon={<KeyRound size={16} aria-hidden="true" />}
            disabled={busy || asking}
            onClick={() => {
              void confirmWithPasskey();
            }}
          >
            {t('me:passkeys.usePasskey')}
          </Button>
          <Typography
            variant="caption"
            sx={{ color: 'text.secondary', textAlign: 'center' }}
            aria-hidden="true"
          >
            {t('me:passkeys.or')}
          </Typography>
        </>
      ) : null}
      <TextField
        id={fieldId}
        type="password"
        label={t('me:passkeys.proofLabel')}
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
        }}
        error={shown !== null}
        helperText={shown ?? ' '}
        fullWidth
        slotProps={{ htmlInput: { autoComplete: 'current-password' } }}
      />
    </ConfirmDialog>
  );
}

/** The browser's own prompt is open (or has just been closed without a passkey). */
function PromptDialog({
  failure,
  busy,
  onRetry,
  onClose,
}: {
  readonly failure: PasskeyCeremonyFailure | null;
  readonly busy: boolean;
  onRetry(): void;
  onClose(): void;
}): ReactNode {
  const t = useT();
  const titleId = useId();
  const message =
    failure === null
      ? null
      : failure === 'cancelled'
        ? t('me:passkeys.cancelled')
        : failure === 'duplicate'
          ? t('me:passkeys.duplicate')
          : failure === 'unsupported'
            ? t('me:passkeys.unsupported')
            : t('me:passkeys.failed');

  return (
    <Dialog
      open
      onClose={onClose}
      aria-labelledby={titleId}
      maxWidth="xs"
      fullWidth
      slotProps={{ paper: { sx: { maxWidth: 480, borderRadius: '10px' } } }}
    >
      <DialogTitle id={titleId} sx={{ fontSize: 16, fontWeight: 600 }}>
        {t('me:passkeys.waitingTitle')}
      </DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {message === null ? (
          <Box
            role="status"
            sx={{ display: 'flex', alignItems: 'center', gap: 2, color: 'text.secondary' }}
          >
            <KeyRound size={16} aria-hidden="true" />
            <Typography variant="body2">{t('me:passkeys.waitingBody')}</Typography>
          </Box>
        ) : (
          <AlertBanner tone={failure === 'cancelled' ? 'info' : 'danger'}>{message}</AlertBanner>
        )}
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          {t('me:passkeys.waitingHint')}
        </Typography>
      </DialogContent>
      <DialogActions sx={{ padding: 4, gap: 2 }}>
        <Button variant="text" onClick={onClose}>
          {message === null ? t('common:actions.cancel') : t('me:passkeys.close')}
        </Button>
        {message === null || failure === 'duplicate' || failure === 'unsupported' ? null : (
          <Button variant="contained" disabled={busy} onClick={onRetry}>
            {t('me:passkeys.tryAgain')}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}

/** Naming a new passkey, or renaming one: the same field either way. */
function NameDialog({
  title,
  body,
  initial,
  busy,
  onSave,
  onClose,
}: {
  readonly title: string;
  readonly body: string;
  readonly initial: string;
  readonly busy: boolean;
  onSave(name: string): void;
  onClose(): void;
}): ReactNode {
  const t = useT();
  const fieldId = useId();
  const [name, setName] = useState(initial);
  const [problem, setProblem] = useState<string | null>(null);

  const save = (): void => {
    const trimmed = name.trim();
    if (trimmed === '') {
      setProblem(t('me:passkeys.nameRequired'));
      return;
    }
    setProblem(null);
    onSave(trimmed);
  };

  return (
    <ConfirmDialog
      open
      busy={busy}
      title={title}
      body={body}
      confirmLabel={t('me:passkeys.save')}
      onClose={onClose}
      onConfirm={save}
    >
      <TextField
        id={fieldId}
        label={t('me:passkeys.nameLabel')}
        value={name}
        onChange={(event) => {
          setName(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            save();
          }
        }}
        error={problem !== null}
        helperText={problem ?? t('me:passkeys.nameHint')}
        fullWidth
        autoFocus
        slotProps={{ htmlInput: { maxLength: 64 } }}
      />
    </ConfirmDialog>
  );
}
