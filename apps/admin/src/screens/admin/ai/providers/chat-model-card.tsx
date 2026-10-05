import type { AiProvidersOverview, BrandAiSettings } from '@helpdock/schemas';
import { Box, Button, MenuItem, Select, Typography } from '@mui/material';
import { useMutation, useQueries, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useId, useState } from 'react';
import { aiKeys } from '../../../../ai/api.js';
import { useAiApi } from '../../../../ai/context.tsx';
import { useT } from '../../../../app/i18n.js';
import { useSemanticTokens } from '../../../../app/tokens.js';
import { useSession } from '../../../../auth/session.tsx';
import { EnvChip } from '../../../../ui/env-locked-field.tsx';
import { Field } from '../../../../ui/field.tsx';
import { useToast } from '../../../../ui/toasts.tsx';
import { SectionCard } from '../../channels/section-card.tsx';
import { failureMessage } from '../format.js';
import { settingsUpdateOf } from '../settings-update.js';

/**
 * The Chat model card of `Admin/AI-Providers`: the install default, then each
 * brand's override. The choices are the models discovered from each provider;
 * one that cannot be asked contributes none, and the stored choice is always
 * listed so a save never changes what it did not touch.
 */

const SEPARATOR = '\u0000';
const choiceOf = (providerId: string | null, modelId: string | null): string =>
  providerId === null || modelId === null ? '' : `${providerId}${SEPARATOR}${modelId}`;
const pairOf = (choice: string): { providerId: string | null; modelId: string | null } => {
  const [providerId, modelId] = choice.split(SEPARATOR);
  return providerId === undefined || modelId === undefined || choice === ''
    ? { providerId: null, modelId: null }
    : { providerId, modelId };
};

export function ChatModelCard({ overview }: { readonly overview: AiProvidersOverview }): ReactNode {
  const t = useT();
  const api = useAiApi();
  const toast = useToast();
  const tokens = useSemanticTokens();
  const queryClient = useQueryClient();
  const session = useSession();
  const id = useId();

  const models = useQueries({
    queries: overview.providers.map((provider) => ({
      queryKey: aiKeys.models(provider.id),
      queryFn: () => api.models(provider.id),
    })),
  });
  const brands = useQueries({
    queries: session.brands.map((brand) => ({
      queryKey: aiKeys.brand(brand.id),
      queryFn: () => api.brandSettings(brand.id),
    })),
  });

  const stored = choiceOf(overview.defaults.providerId, overview.defaults.modelId);
  const [defaultChoice, setDefaultChoice] = useState<string | null>(null);
  const [overrides, setOverrides] = useState<Readonly<Record<string, string>>>({});

  const options = new Map<string, string>();
  overview.providers.forEach((provider, index) => {
    for (const model of models[index]?.data?.models ?? []) {
      options.set(choiceOf(provider.id, model.id), `${provider.label} · ${model.id}`);
    }
  });
  const labelOf = (choice: string): string => {
    const { providerId, modelId } = pairOf(choice);
    const provider = overview.providers.find((candidate) => candidate.id === providerId);
    return `${provider?.label ?? providerId ?? ''} · ${modelId ?? ''}`;
  };
  const withStored = (choice: string): [string, string][] => {
    const all = new Map(options);
    if (choice !== '' && !all.has(choice)) {
      all.set(choice, labelOf(choice));
    }
    return [...all.entries()];
  };

  const save = useMutation({
    mutationFn: async (): Promise<void> => {
      if (defaultChoice !== null && defaultChoice !== stored && defaultChoice !== '') {
        const pair = pairOf(defaultChoice);
        if (pair.providerId !== null && pair.modelId !== null) {
          await api.setDefaultModel({ providerId: pair.providerId, modelId: pair.modelId });
        }
      }
      for (const [brandId, choice] of Object.entries(overrides)) {
        const settings = brands[session.brands.findIndex((brand) => brand.id === brandId)]?.data;
        if (settings !== undefined && choice !== choiceOf(settings.providerId, settings.modelId)) {
          await api.saveBrandSettings(brandId, {
            ...settingsUpdateOf(settings),
            ...pairOf(choice),
          });
        }
      }
    },
    onSuccess: async () => {
      setDefaultChoice(null);
      setOverrides({});
      await queryClient.invalidateQueries({ queryKey: ['ai'] });
      toast({ tone: 'success', message: t('aiSettings:chatModel.saved') });
    },
    onError: (error: unknown) => {
      toast({ tone: 'danger', message: failureMessage(t, error) });
    },
  });

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    save.mutate();
  };
  const currentDefault = defaultChoice ?? stored;

  return (
    <SectionCard
      id={`${id}-chat`}
      heading={t('aiSettings:chatModel.heading')}
      caption={t('aiSettings:chatModel.caption')}
      aside={overview.locked.defaults ? <EnvChip /> : undefined}
      onSubmit={submit}
      footer={
        <>
          <Button
            variant="text"
            disabled={save.isPending}
            onClick={() => {
              setDefaultChoice(null);
              setOverrides({});
            }}
          >
            {t('aiSettings:discard')}
          </Button>
          <Button type="submit" variant="contained" disabled={save.isPending}>
            {t('aiSettings:save')}
          </Button>
        </>
      }
    >
      <Field
        id={`${id}-default`}
        label={t('aiSettings:chatModel.installDefault')}
        hint={
          overview.locked.defaults
            ? t('aiSettings:chatModel.lockedHint')
            : t('aiSettings:chatModel.installDefaultHint')
        }
      >
        <Select
          id={`${id}-default`}
          size="small"
          value={currentDefault}
          displayEmpty
          disabled={overview.locked.defaults}
          onChange={(event) => {
            setDefaultChoice(event.target.value);
          }}
          inputProps={{ 'aria-label': t('aiSettings:chatModel.installDefault') }}
        >
          <MenuItem value="" disabled>
            {t('aiSettings:chatModel.notSet')}
          </MenuItem>
          {withStored(currentDefault).map(([value, label]) => (
            <MenuItem key={value} value={value}>
              {label}
            </MenuItem>
          ))}
        </Select>
      </Field>

      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        <Typography sx={{ fontSize: 13, fontWeight: 600 }}>
          {t('aiSettings:chatModel.perBrand')}
        </Typography>
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          {t('aiSettings:chatModel.perBrandCaption')}
        </Typography>
      </Box>
      <Box component="ul" sx={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {session.brands.map((brand, index) => {
          const settings: BrandAiSettings | undefined = brands[index]?.data;
          const choice =
            overrides[brand.id] ??
            choiceOf(settings?.providerId ?? null, settings?.modelId ?? null);
          return (
            <Box
              component="li"
              key={brand.id}
              sx={{
                display: 'grid',
                gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.4fr)',
                alignItems: 'center',
                gap: 3,
                paddingBlock: 2,
                borderBlockStart: `1px solid ${tokens['bg.muted']}`,
              }}
            >
              <Typography
                component="label"
                htmlFor={`${id}-brand-${brand.id}`}
                sx={{ fontSize: 13, fontWeight: 500 }}
              >
                {brand.name}
              </Typography>
              <Select
                id={`${id}-brand-${brand.id}`}
                size="small"
                value={choice}
                displayEmpty
                disabled={settings === undefined}
                onChange={(event) => {
                  setOverrides((held) => ({ ...held, [brand.id]: event.target.value }));
                }}
                inputProps={{
                  'aria-label': t('aiSettings:chatModel.brandModel', { brand: brand.name }),
                }}
              >
                <MenuItem value="">{t('aiSettings:chatModel.useDefault')}</MenuItem>
                {withStored(choice).map(([value, label]) => (
                  <MenuItem key={value} value={value}>
                    {label}
                  </MenuItem>
                ))}
              </Select>
            </Box>
          );
        })}
      </Box>
    </SectionCard>
  );
}
