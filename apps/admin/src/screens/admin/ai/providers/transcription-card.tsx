import type { TranscriptionSettingsUpdate, TranscriptionSettingsView } from '@helpdock/schemas';
import { Box, Button, TextField, Typography } from '@mui/material';
import { useQueryClient } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useId, useState } from 'react';
import { aiKeys } from '../../../../ai/api.js';
import { useAiApi } from '../../../../ai/context.tsx';
import { useT } from '../../../../app/i18n.js';
import { useSemanticTokens } from '../../../../app/tokens.js';
import { EnvChip, EnvLockedField } from '../../../../ui/env-locked-field.tsx';
import { Field, fieldDescribedBy } from '../../../../ui/field.tsx';
import { SecretField } from '../../../../ui/secret-field.tsx';
import { SectionCard } from '../../channels/section-card.tsx';
import { envKeyOf } from '../format.js';
import { useAiAction } from '../use-ai-action.js';

/**
 * Voice transcription on `Admin/AI-Providers`: the Whisper-compatible
 * endpoint, its model and key. A key the environment pins is drawn as an
 * EnvLockedField, and the card carries the "Set by environment" chip.
 */
export function TranscriptionCard({
  settings,
}: {
  readonly settings: TranscriptionSettingsView;
}): ReactNode {
  const t = useT();
  const api = useAiApi();
  const tokens = useSemanticTokens();
  const queryClient = useQueryClient();
  const id = useId();
  const [endpoint, setEndpoint] = useState(settings.endpoint);
  const [model, setModel] = useState(settings.model);
  const [apiKey, setApiKey] = useState<string | null>(settings.hasApiKey ? null : '');
  const [invalid, setInvalid] = useState(false);

  const locked = (key: string): boolean => settings.lockedKeys.includes(key);
  const save = useAiAction(
    (request: TranscriptionSettingsUpdate) => api.saveTranscription(request),
    t('aiSettings:transcription.saved'),
    (saved) => {
      queryClient.setQueryData(aiKeys.transcription, saved);
      setEndpoint(saved.endpoint);
      setApiKey(saved.hasApiKey ? null : '');
    },
  );

  const send = (nextEndpoint: string): void => {
    const trimmed = nextEndpoint.trim();
    if (trimmed !== '' && !/^https?:\/\/\S+$/.test(trimmed)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    save.mutate({
      endpoint: trimmed,
      model: model.trim(),
      ...(apiKey === null ? {} : { apiKey }),
    });
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    send(endpoint);
  };

  const on = settings.endpoint !== '';
  const endpointHint = t('aiSettings:transcription.endpointHint');
  const endpointError = invalid ? t('aiSettings:transcription.endpointInvalid') : undefined;

  return (
    <SectionCard
      id={`${id}-transcription`}
      heading={t('aiSettings:transcription.heading')}
      caption={t('aiSettings:transcription.caption')}
      aside={settings.lockedKeys.length > 0 ? <EnvChip /> : undefined}
      onSubmit={submit}
      footer={
        <>
          {on && !locked('transcription.endpoint') ? (
            <Button
              variant="text"
              disabled={save.isPending}
              onClick={() => {
                send('');
              }}
            >
              {t('aiSettings:transcription.turnOff')}
            </Button>
          ) : null}
          <Button type="submit" variant="contained" disabled={save.isPending}>
            {t('aiSettings:save')}
          </Button>
        </>
      }
    >
      {locked('transcription.endpoint') ? (
        <EnvLockedField
          id={`${id}-endpoint`}
          label={t('aiSettings:transcription.endpoint')}
          value={settings.endpoint}
          variable={envKeyOf('transcription.endpoint')}
        />
      ) : (
        <Field
          id={`${id}-endpoint`}
          label={t('aiSettings:transcription.endpoint')}
          hint={endpointHint}
          error={endpointError}
        >
          <TextField
            id={`${id}-endpoint`}
            size="small"
            value={endpoint}
            error={invalid}
            placeholder="https://api.openai.com/v1/audio/transcriptions"
            onChange={(event) => {
              setEndpoint(event.target.value);
            }}
            slotProps={{
              htmlInput: {
                dir: 'ltr',
                spellCheck: false,
                'aria-describedby': fieldDescribedBy(`${id}-endpoint`, {
                  hint: endpointHint,
                  error: endpointError,
                }),
              },
            }}
          />
        </Field>
      )}

      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', sm: 'minmax(0, 1fr) minmax(0, 1fr)' },
          gap: 3,
        }}
      >
        {locked('transcription.model') ? (
          <EnvLockedField
            id={`${id}-model`}
            label={t('aiSettings:transcription.model')}
            value={settings.model}
            variable={envKeyOf('transcription.model')}
          />
        ) : (
          <Field id={`${id}-model`} label={t('aiSettings:transcription.model')}>
            <TextField
              id={`${id}-model`}
              size="small"
              value={model}
              onChange={(event) => {
                setModel(event.target.value);
              }}
              slotProps={{ htmlInput: { dir: 'ltr', maxLength: 200, spellCheck: false } }}
            />
          </Field>
        )}
        {locked('transcription.apiKey') ? (
          <EnvLockedField
            id={`${id}-key`}
            label={t('aiSettings:transcription.apiKey')}
            value="••••••••"
            variable={envKeyOf('transcription.apiKey')}
          />
        ) : (
          <SecretField
            id={`${id}-key`}
            label={t('aiSettings:transcription.apiKey')}
            stored={settings.hasApiKey}
            value={apiKey}
            replaceLabel={t('aiSettings:transcription.replaceKey')}
            onChange={setApiKey}
          />
        )}
      </Box>

      <Typography
        role="status"
        variant="caption"
        sx={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}
      >
        <Box
          component="span"
          aria-hidden="true"
          sx={{
            width: 8,
            height: 8,
            borderRadius: '999px',
            backgroundColor: on ? tokens['status.success'] : tokens['border.strong'],
          }}
        />
        {on ? t('aiSettings:transcription.on') : t('aiSettings:transcription.off')}
      </Typography>
    </SectionCard>
  );
}
