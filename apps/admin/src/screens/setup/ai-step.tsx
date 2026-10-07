import type { AiModelList, AiProviderUpsert } from '@helpdock/schemas';
import { aiOAuthCredentialsSchema } from '@helpdock/schemas';
import {
  Box,
  Button,
  FormControlLabel,
  MenuItem,
  OutlinedInput,
  Radio,
  RadioGroup,
  Select,
  Typography,
} from '@mui/material';
import { useMutation } from '@tanstack/react-query';
import { CircleCheck, KeyRound, LogIn, RefreshCw } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useT } from '../../app/i18n.js';
import { useSemanticTokens } from '../../app/tokens.js';
import { AlertBanner } from '../../ui/alert-banner.tsx';
import { Field, fieldDescribedBy } from '../../ui/field.tsx';
import { failureMessage } from '../admin/ai/format.js';
import type { SetupAi } from './setup-ai.js';
import { StepFrame } from './setup-layout.tsx';

/**
 * Step 4 of the first-run wizard, `Admin/Wizard-AI` (M7-10): connect one
 * provider and pick the default chat model, or skip. Optional, because an
 * install works without AI and every AI mode starts off; embeddings,
 * transcription and more providers are in AI › Providers.
 *
 * "Test and find models" saves the provider and asks it for its models, so
 * the operator learns the key works before choosing; "Save and continue" sets
 * the default model.
 */

export interface WizardProvider {
  readonly kind: string;
  readonly label: string;
  /** pi-ai has a subscription login for it. */
  readonly subscription: boolean;
}

export const WIZARD_PROVIDERS: readonly WizardProvider[] = [
  { kind: 'openai', label: 'OpenAI', subscription: true },
  { kind: 'anthropic', label: 'Anthropic', subscription: true },
  { kind: 'google', label: 'Google', subscription: false },
  { kind: 'openrouter', label: 'OpenRouter', subscription: false },
];

type SignIn = 'apiKey' | 'oauth';

/** The credential typed, or null when there is nothing usable to send yet. */
export const wizardAuthOf = (signIn: SignIn, typed: string): AiProviderUpsert['auth'] | null => {
  if (typed.trim() === '') {
    return null;
  }
  if (signIn === 'apiKey') {
    return { type: 'apiKey', apiKey: typed.trim() };
  }
  try {
    const credentials = aiOAuthCredentialsSchema.safeParse(JSON.parse(typed));
    return credentials.success ? { type: 'oauth', credentials: credentials.data } : null;
  } catch {
    return null;
  }
};

export function AiStep({
  ai,
  onDecided,
  onBack,
}: {
  readonly ai: SetupAi;
  /** "OpenAI · gpt-4.1-mini" once saved, or null when skipped. */
  onDecided(model: string | null): void;
  onBack(): void;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const [kind, setKind] = useState('openai');
  const [signIn, setSignIn] = useState<SignIn>('apiKey');
  const [credential, setCredential] = useState('');
  const [model, setModel] = useState('');
  const [problem, setProblem] = useState<'credential' | 'model' | null>(null);
  const provider =
    WIZARD_PROVIDERS.find((candidate) => candidate.kind === kind) ?? WIZARD_PROVIDERS[0];

  const connect = useMutation({
    mutationFn: async (auth: AiProviderUpsert['auth']): Promise<AiModelList> => {
      await ai.signIn();
      await ai.api.saveProvider(kind, {
        kind,
        label: provider?.label ?? kind,
        baseUrl: null,
        auth,
      });
      return ai.api.models(kind);
    },
    onSuccess: (list) => {
      setModel(list.models[0]?.id ?? '');
    },
  });

  const save = useMutation({
    mutationFn: () => ai.api.setDefaultModel({ providerId: kind, modelId: model }),
    onSuccess: () => {
      onDecided(`${provider?.label ?? kind} · ${model}`);
    },
  });

  const reset = (): void => {
    connect.reset();
    setModel('');
    setProblem(null);
  };

  const test = (): void => {
    const auth = wizardAuthOf(signIn, credential);
    setProblem(auth === null ? 'credential' : null);
    if (auth !== null) {
      connect.mutate(auth);
    }
  };

  const submit = (): void => {
    if (connect.data === undefined || model === '') {
      setProblem(connect.data === undefined ? 'credential' : 'model');
      return;
    }
    setProblem(null);
    save.mutate();
  };

  const credentialLabel =
    signIn === 'apiKey' ? t('wizard:ai.apiKeyLabel') : t('wizard:ai.credentialsLabel');
  const credentialError =
    problem === 'credential'
      ? t(signIn === 'apiKey' ? 'wizard:ai.apiKeyRequired' : 'wizard:ai.credentialsInvalid')
      : undefined;
  const credentialHint = t('wizard:ai.hint');
  const failure = connect.error ?? save.error;

  return (
    <StepFrame
      title={t('wizard:ai.title')}
      badge={
        <Box
          component="span"
          sx={{
            fontSize: 12,
            fontWeight: 600,
            paddingInline: 2,
            borderRadius: '6px',
            backgroundColor: tokens['bg.muted'],
            color: 'text.secondary',
          }}
        >
          {t('wizard:ai.optional')}
        </Box>
      }
      description={t('wizard:ai.description')}
      onSubmit={submit}
      footer={
        <>
          <Button type="button" variant="text" color="secondary" onClick={onBack}>
            {t('wizard:back')}
          </Button>
          <Button
            type="button"
            variant="text"
            color="secondary"
            disabled={connect.isPending || save.isPending}
            onClick={() => {
              onDecided(null);
            }}
          >
            {t('wizard:ai.skip')}
          </Button>
          <Button type="submit" variant="contained" color="primary" loading={save.isPending}>
            {t('wizard:ai.submit')}
          </Button>
        </>
      }
    >
      {failure === null ? null : (
        <AlertBanner tone="danger">{failureMessage(t, failure)}</AlertBanner>
      )}

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 4 }}>
        <Field id="setup-ai-provider" label={t('wizard:ai.providerLabel')}>
          <Select
            id="setup-ai-provider"
            value={kind}
            onChange={(event) => {
              const next = WIZARD_PROVIDERS.find(
                (candidate) => candidate.kind === event.target.value,
              );
              setKind(event.target.value);
              if (next?.subscription !== true) {
                setSignIn('apiKey');
              }
              reset();
            }}
            inputProps={{ 'aria-label': t('wizard:ai.providerLabel') }}
          >
            {WIZARD_PROVIDERS.map((candidate) => (
              <MenuItem key={candidate.kind} value={candidate.kind}>
                {candidate.label}
              </MenuItem>
            ))}
          </Select>
        </Field>
        <Box component="fieldset" sx={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
          <Typography
            component="legend"
            sx={{ fontSize: 13, fontWeight: 500, marginBlockEnd: '6px' }}
          >
            {t('wizard:ai.signInWith')}
          </Typography>
          <RadioGroup
            row
            value={signIn}
            onChange={(event) => {
              setSignIn(event.target.value as SignIn);
              setCredential('');
              reset();
            }}
          >
            <FormControlLabel
              value="apiKey"
              control={<Radio size="small" />}
              label={
                <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 1 }}>
                  <KeyRound size={14} aria-hidden="true" />
                  {t('wizard:ai.apiKey')}
                </Box>
              }
            />
            <FormControlLabel
              value="oauth"
              disabled={provider?.subscription !== true}
              control={<Radio size="small" />}
              label={
                <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 1 }}>
                  <LogIn size={14} aria-hidden="true" />
                  {t('wizard:ai.subscription')}
                </Box>
              }
            />
          </RadioGroup>
        </Box>
      </Box>

      <Field
        id="setup-ai-credential"
        label={credentialLabel}
        hint={credentialHint}
        error={credentialError}
        action={
          connect.data === undefined ? undefined : <Connected count={connect.data.models.length} />
        }
      >
        <Box sx={{ display: 'flex', gap: 2, alignItems: 'flex-start' }}>
          <OutlinedInput
            id="setup-ai-credential"
            value={credential}
            type={signIn === 'apiKey' ? 'password' : 'text'}
            multiline={signIn === 'oauth'}
            minRows={signIn === 'oauth' ? 3 : undefined}
            error={credentialError !== undefined}
            onChange={(event) => {
              setCredential(event.target.value);
              if (connect.data !== undefined) {
                reset();
              }
            }}
            fullWidth
            slotProps={{
              input: {
                dir: 'ltr',
                autoComplete: 'off',
                spellCheck: false,
                'aria-describedby': fieldDescribedBy('setup-ai-credential', {
                  hint: credentialHint,
                  error: credentialError,
                }),
              },
            }}
          />
          <Button
            variant="outlined"
            onClick={test}
            loading={connect.isPending}
            startIcon={<RefreshCw size={16} aria-hidden="true" />}
            sx={{ flexShrink: 0 }}
          >
            {t('wizard:ai.test')}
          </Button>
        </Box>
      </Field>

      <Field
        id="setup-ai-model"
        label={t('wizard:ai.modelLabel')}
        error={problem === 'model' ? t('wizard:ai.modelRequired') : undefined}
      >
        <Select
          id="setup-ai-model"
          value={model}
          displayEmpty
          disabled={connect.data === undefined}
          onChange={(event) => {
            setModel(event.target.value);
          }}
          inputProps={{ 'aria-label': t('wizard:ai.modelLabel') }}
          sx={{ fontFamily: 'var(--hd-font-mono, monospace)' }}
        >
          <MenuItem value="" disabled>
            {t('wizard:ai.modelPlaceholder')}
          </MenuItem>
          {(connect.data?.models ?? []).map((candidate) => (
            <MenuItem key={candidate.id} value={candidate.id}>
              {candidate.id}
            </MenuItem>
          ))}
        </Select>
      </Field>
    </StepFrame>
  );
}

function Connected({ count }: { readonly count: number }): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();

  return (
    <Typography
      role="status"
      variant="caption"
      sx={{
        color: tokens['status.success.text'],
        display: 'inline-flex',
        alignItems: 'center',
        gap: 1,
      }}
    >
      <CircleCheck size={14} aria-hidden="true" />
      {t('wizard:ai.connected', { count })}
    </Typography>
  );
}
