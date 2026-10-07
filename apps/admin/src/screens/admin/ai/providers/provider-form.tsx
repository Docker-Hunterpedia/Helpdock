import type {
  AiAuthType,
  AiModelList,
  AiProviderKind,
  AiProviderUpsert,
  AiProviderView,
} from '@helpdock/schemas';
import {
  Box,
  Button,
  CircularProgress,
  MenuItem,
  Radio,
  Select,
  TextField,
  Typography,
} from '@mui/material';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CircleCheck, KeyRound, LogIn, RefreshCw, Server } from 'lucide-react';
import { type FormEvent, type ReactNode, useId, useState } from 'react';
import { aiKeys } from '../../../../ai/api.js';
import { useAiApi } from '../../../../ai/context.tsx';
import { useT } from '../../../../app/i18n.js';
import { useSemanticTokens } from '../../../../app/tokens.js';
import { AlertBanner } from '../../../../ui/alert-banner.tsx';
import { ConfirmDialog } from '../../../../ui/confirm-dialog.tsx';
import { Field, fieldDescribedBy } from '../../../../ui/field.tsx';
import { SecretField } from '../../../../ui/secret-field.tsx';
import { SectionCard } from '../../channels/section-card.tsx';
import { failureMessage, kindLabel } from '../format.js';
import { useAiAction } from '../use-ai-action.js';
import { ModelsTable } from './models-table.tsx';
import {
  draftOf,
  type ProviderDraft,
  type ProviderField,
  type ProviderProblem,
  providerRequestOf,
} from './provider-draft.js';

/**
 * The provider form of `Admin/AI-Providers`: kind, base URL, the credential
 * type as two radio cards, the key as a SecretField, "Discover models" and
 * Remove. A new provider is given an id here, which brands name it by.
 */
export function ProviderForm({
  provider,
  kinds,
  locked,
  onSaved,
  onRemoved,
}: {
  /** Null for "Add provider". */
  readonly provider: AiProviderView | null;
  readonly kinds: readonly AiProviderKind[];
  /** `HD_AI_PROVIDERS` pins the list, so nothing here can be saved. */
  readonly locked: boolean;
  onSaved(providerId: string): void;
  onRemoved(): void;
}): ReactNode {
  const t = useT();
  const api = useAiApi();
  const queryClient = useQueryClient();
  const id = useId();
  const [draft, setDraft] = useState<ProviderDraft>(() => draftOf(provider));
  const [problems, setProblems] = useState<Partial<Record<ProviderField, ProviderProblem>>>({});
  const [removing, setRemoving] = useState(false);
  const kind = kinds.find((candidate) => candidate.id === draft.kind);

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: aiKeys.providers });
  };
  const save = useAiAction(
    ({ providerId, request }: { providerId: string; request: AiProviderUpsert }) =>
      api.saveProvider(providerId, request),
    t('aiSettings:provider.saved'),
    async (saved) => {
      await refresh();
      onSaved(saved.id);
    },
  );
  const remove = useAiAction(
    (providerId: string) => api.removeProvider(providerId),
    t('aiSettings:provider.removed'),
    async () => {
      setRemoving(false);
      await refresh();
      onRemoved();
    },
  );
  const discover = useMutation({
    mutationFn: (providerId: string): Promise<AiModelList> => api.models(providerId),
    onSuccess: (list, providerId) => {
      queryClient.setQueryData(aiKeys.models(providerId), list);
    },
  });

  const set = (patch: Partial<ProviderDraft>): void => {
    setDraft((held) => ({ ...held, ...patch }));
  };

  const chooseAuth = (authType: AiAuthType): void => {
    const stored = provider?.authType === authType;
    set({
      authType,
      apiKey: stored && authType === 'apiKey' ? null : '',
      oauth: stored && authType === 'oauth' ? null : '',
    });
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const outcome = providerRequestOf(draft, kind);
    if (!outcome.ok) {
      setProblems(outcome.problems);
      return;
    }
    setProblems({});
    save.mutate({ providerId: outcome.id, request: outcome.request });
  };

  const problemText = (field: ProviderField): string | undefined => {
    const problem = problems[field];
    return problem === undefined ? undefined : t(`aiSettings:provider.problems.${problem}`);
  };

  const heading = provider === null ? t('aiSettings:provider.addHeading') : provider.label;

  return (
    <SectionCard
      id={`${id}-provider`}
      heading={heading}
      caption={
        provider === null
          ? t('aiSettings:provider.addCaption')
          : t('aiSettings:provider.editCaption')
      }
      onSubmit={submit}
      footer={
        locked ? undefined : (
          <Box sx={{ display: 'flex', width: '100%', gap: 2, alignItems: 'center' }}>
            {provider === null ? null : (
              <Button
                variant="outlined"
                color="error"
                onClick={() => {
                  setRemoving(true);
                }}
              >
                {t('aiSettings:provider.remove')}
              </Button>
            )}
            <Box sx={{ flex: 1 }} />
            <Button
              variant="text"
              disabled={save.isPending}
              onClick={() => {
                setDraft(draftOf(provider));
                setProblems({});
              }}
            >
              {t('aiSettings:discard')}
            </Button>
            <Button type="submit" variant="contained" disabled={save.isPending}>
              {t('aiSettings:provider.save')}
            </Button>
          </Box>
        )
      }
    >
      {locked ? <AlertBanner tone="info">{t('aiSettings:provider.locked')}</AlertBanner> : null}

      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', sm: 'minmax(0, 1fr) minmax(0, 1fr)' },
          gap: 3,
        }}
      >
        <Field id={`${id}-kind`} label={t('aiSettings:provider.kind')}>
          <Select
            id={`${id}-kind`}
            size="small"
            value={draft.kind}
            disabled={locked || provider !== null}
            onChange={(event) => {
              set({ kind: event.target.value });
            }}
            inputProps={{ 'aria-label': t('aiSettings:provider.kind') }}
          >
            {kinds.map((candidate) => (
              <MenuItem key={candidate.id} value={candidate.id}>
                {kindLabel(t, candidate.id)}
              </MenuItem>
            ))}
          </Select>
        </Field>
        <Field
          id={`${id}-base-url`}
          label={
            kind?.needsBaseUrl === true
              ? t('aiSettings:provider.baseUrl')
              : t('aiSettings:provider.baseUrlOptional')
          }
          hint={t('aiSettings:provider.baseUrlHint')}
          error={problemText('baseUrl')}
        >
          <TextField
            id={`${id}-base-url`}
            size="small"
            value={draft.baseUrl}
            disabled={locked}
            error={problems.baseUrl !== undefined}
            placeholder="https://api.openai.com/v1"
            onChange={(event) => {
              set({ baseUrl: event.target.value });
            }}
            slotProps={{
              htmlInput: {
                dir: 'ltr',
                spellCheck: false,
                'aria-describedby': fieldDescribedBy(`${id}-base-url`, {
                  hint: t('aiSettings:provider.baseUrlHint'),
                  error: problemText('baseUrl'),
                }),
              },
            }}
          />
        </Field>
        {provider === null ? (
          <Field
            id={`${id}-slug`}
            label={t('aiSettings:provider.id')}
            hint={t('aiSettings:provider.idHint')}
            error={problemText('id')}
          >
            <TextField
              id={`${id}-slug`}
              size="small"
              value={draft.id}
              error={problems.id !== undefined}
              onChange={(event) => {
                set({ id: event.target.value.toLowerCase() });
              }}
              slotProps={{
                htmlInput: {
                  dir: 'ltr',
                  maxLength: 40,
                  spellCheck: false,
                  'aria-describedby': fieldDescribedBy(`${id}-slug`, {
                    hint: t('aiSettings:provider.idHint'),
                    error: problemText('id'),
                  }),
                },
              }}
            />
          </Field>
        ) : null}
        <Field
          id={`${id}-label`}
          label={t('aiSettings:provider.label')}
          error={problemText('label')}
        >
          <TextField
            id={`${id}-label`}
            size="small"
            value={draft.label}
            disabled={locked}
            error={problems.label !== undefined}
            onChange={(event) => {
              set({ label: event.target.value });
            }}
            slotProps={{ htmlInput: { maxLength: 80 } }}
          />
        </Field>
      </Box>

      <CredentialChoice
        name={`${id}-auth`}
        value={draft.authType}
        oauthAllowed={kind?.oauth === true}
        disabled={locked}
        onChange={chooseAuth}
      />

      {draft.authType === 'apiKey' ? (
        <SecretField
          id={`${id}-key`}
          label={t('aiSettings:provider.apiKey')}
          stored={provider?.authType === 'apiKey'}
          value={draft.apiKey}
          hint={t('aiSettings:provider.apiKeyHint')}
          error={problemText('apiKey')}
          replaceLabel={t('aiSettings:provider.replaceKey', { name: draft.label })}
          onChange={(apiKey) => {
            set({ apiKey });
          }}
        />
      ) : null}
      {draft.authType === 'oauth' ? (
        <OAuthField
          id={`${id}-oauth`}
          kind={draft.kind}
          stored={provider?.authType === 'oauth'}
          value={draft.oauth}
          error={problemText('oauth')}
          onChange={(oauth) => {
            set({ oauth });
          }}
        />
      ) : null}

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 3, flexWrap: 'wrap' }}>
        <Button
          variant="outlined"
          disabled={provider === null || discover.isPending}
          aria-busy={discover.isPending}
          startIcon={
            discover.isPending ? (
              <CircularProgress size={14} aria-hidden="true" />
            ) : (
              <RefreshCw size={14} aria-hidden="true" />
            )
          }
          onClick={() => {
            if (provider !== null) {
              discover.mutate(provider.id);
            }
          }}
        >
          {t('aiSettings:provider.discover')}
        </Button>
        <DiscoveryOutcome
          unsaved={provider === null}
          result={discover.data}
          error={discover.error}
        />
      </Box>
      {discover.data === undefined ? null : (
        <ModelsTable name={heading} models={discover.data.models} />
      )}

      <ConfirmDialog
        open={removing}
        title={t('aiSettings:provider.removeTitle', { name: provider?.label ?? '' })}
        body={t('aiSettings:provider.removeBody')}
        confirmLabel={t('aiSettings:provider.remove')}
        destructive
        busy={remove.isPending}
        onConfirm={() => {
          if (provider !== null) {
            remove.mutate(provider.id);
          }
        }}
        onClose={() => {
          setRemoving(false);
        }}
      />
    </SectionCard>
  );
}

function DiscoveryOutcome({
  unsaved,
  result,
  error,
}: {
  readonly unsaved: boolean;
  readonly result: AiModelList | undefined;
  readonly error: unknown;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();

  if (unsaved) {
    return (
      <Typography variant="caption" sx={{ color: 'text.secondary' }}>
        {t('aiSettings:provider.discoverSaveFirst')}
      </Typography>
    );
  }
  if (error !== null) {
    return (
      <Typography role="alert" variant="caption" sx={{ color: tokens['status.danger.text'] }}>
        {failureMessage(t, error)}
      </Typography>
    );
  }
  if (result === undefined) {
    return null;
  }
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
      {t('aiSettings:provider.modelsFound', { count: result.models.length })}
    </Typography>
  );
}

const CHOICES: readonly { readonly type: AiAuthType; readonly icon: typeof KeyRound }[] = [
  { type: 'apiKey', icon: KeyRound },
  { type: 'oauth', icon: LogIn },
  { type: 'none', icon: Server },
];

/** The credential type as radio cards: the choice and why, side by side. */
function CredentialChoice({
  name,
  value,
  oauthAllowed,
  disabled,
  onChange,
}: {
  readonly name: string;
  readonly value: AiAuthType;
  readonly oauthAllowed: boolean;
  readonly disabled: boolean;
  onChange(type: AiAuthType): void;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const legendId = `${name}-legend`;

  return (
    <Box component="fieldset" sx={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      <Typography
        component="legend"
        id={legendId}
        sx={{ fontSize: 13, fontWeight: 500, marginBlockEnd: '6px' }}
      >
        {t('aiSettings:provider.credentialType')}
      </Typography>
      <Box
        role="radiogroup"
        aria-labelledby={legendId}
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', sm: 'repeat(3, minmax(0, 1fr))' },
          gap: 2,
        }}
      >
        {CHOICES.map(({ type, icon: Icon }) => {
          const checked = value === type;
          const unavailable = type === 'oauth' && !oauthAllowed;
          return (
            <Box
              key={type}
              component="label"
              sx={{
                display: 'flex',
                gap: 2,
                padding: 3,
                borderRadius: '6px',
                border: `1px solid ${checked ? tokens['action.primary'] : tokens['border.default']}`,
                backgroundColor: checked ? tokens['action.primary.tint'] : tokens['bg.surface'],
                cursor: disabled || unavailable ? 'default' : 'pointer',
                opacity: unavailable ? 0.6 : 1,
              }}
            >
              <Radio
                size="small"
                name={name}
                value={type}
                checked={checked}
                disabled={disabled || unavailable}
                onChange={() => {
                  onChange(type);
                }}
                sx={{ padding: 0, alignSelf: 'flex-start' }}
              />
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                <Typography
                  sx={{
                    fontSize: 13,
                    fontWeight: 600,
                    display: 'inline-flex',
                    gap: 1,
                    alignItems: 'center',
                  }}
                >
                  <Icon size={14} aria-hidden="true" />
                  {t(`aiSettings:provider.auth.${type}.title`)}
                </Typography>
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                  {unavailable
                    ? t('aiSettings:provider.auth.oauth.unavailable')
                    : t(`aiSettings:provider.auth.${type}.body`)}
                </Typography>
              </Box>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

/** Subscription credentials, pasted from the `auth.json` pi-ai's login writes. */
function OAuthField({
  id,
  kind,
  stored,
  value,
  error,
  onChange,
}: {
  readonly id: string;
  readonly kind: string;
  readonly stored: boolean;
  readonly value: string | null;
  readonly error: string | undefined;
  onChange(value: string | null): void;
}): ReactNode {
  const t = useT();
  const hint = t('aiSettings:provider.oauthHint', { kind });

  if (value === null && stored) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 3 }}>
        <Typography variant="body2" sx={{ color: 'text.secondary', flex: 1 }}>
          {t('aiSettings:provider.oauthStored')}
        </Typography>
        <Button
          variant="outlined"
          onClick={() => {
            onChange('');
          }}
        >
          {t('aiSettings:secret.replace')}
        </Button>
      </Box>
    );
  }
  return (
    <Field id={id} label={t('aiSettings:provider.oauthLabel')} hint={hint} error={error}>
      <TextField
        id={id}
        multiline
        minRows={3}
        size="small"
        value={value ?? ''}
        error={error !== undefined}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        slotProps={{
          htmlInput: {
            dir: 'ltr',
            spellCheck: false,
            'aria-describedby': fieldDescribedBy(id, { hint, error }),
            style: { fontFamily: 'var(--hd-font-mono, monospace)', fontSize: 13 },
          },
        }}
      />
    </Field>
  );
}
