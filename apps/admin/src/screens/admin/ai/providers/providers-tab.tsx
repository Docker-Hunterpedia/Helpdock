import type {
  AiProvidersOverview,
  EmbeddingSettingsView,
  TranscriptionSettingsView,
} from '@helpdock/schemas';
import { Box } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { aiKeys } from '../../../../ai/api.js';
import { useAiApi } from '../../../../ai/context.tsx';
import { useT } from '../../../../app/i18n.js';
import { AlertBanner } from '../../../../ui/alert-banner.tsx';
import { envKeyOf } from '../format.js';
import { ChatModelCard } from './chat-model-card.tsx';
import { EmbeddingsCard } from './embeddings-card.tsx';
import { ProviderForm } from './provider-form.tsx';
import { ProvidersTable } from './providers-table.tsx';
import { TranscriptionCard } from './transcription-card.tsx';

/**
 * AI › Providers (`Admin/AI-Providers`): the providers table, the open
 * provider's form beside the chat model and transcription cards, then the
 * install's one embedding model. Install admins only; the api answers 403 to
 * anybody else, which the load-failed banner draws.
 */
export function ProvidersTab(): ReactNode {
  const t = useT();
  const api = useAiApi();
  const providers = useQuery({ queryKey: aiKeys.providers, queryFn: () => api.providers() });
  const transcription = useQuery({
    queryKey: aiKeys.transcription,
    queryFn: () => api.transcription(),
  });
  const embedding = useQuery({ queryKey: aiKeys.embedding, queryFn: () => api.embedding() });
  const [open, setOpen] = useState<string | 'new' | null>(null);

  if (providers.isError || transcription.isError || embedding.isError) {
    return <AlertBanner tone="danger">{t('aiSettings:loadFailed')}</AlertBanner>;
  }
  if (
    providers.data === undefined ||
    transcription.data === undefined ||
    embedding.data === undefined
  ) {
    return <Box aria-busy="true" />;
  }

  const overview = providers.data;
  const selected = open ?? overview.providers[0]?.id ?? 'new';
  const provider = overview.providers.find((candidate) => candidate.id === selected) ?? null;
  const locked = lockedVariables(overview, transcription.data, embedding.data);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {locked.length === 0 ? null : (
        <AlertBanner tone="warning">
          {t('aiSettings:env.banner', { count: locked.length, keys: locked.join(', ') })}
        </AlertBanner>
      )}

      <ProvidersTable
        overview={overview}
        selected={provider?.id ?? null}
        onOpen={setOpen}
        onAdd={() => {
          setOpen('new');
        }}
      />

      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: 'minmax(0, 1fr)', lg: 'minmax(0, 1fr) minmax(0, 1fr)' },
          gap: 6,
          alignItems: 'start',
        }}
      >
        <ProviderForm
          key={provider?.id ?? 'new'}
          provider={provider}
          kinds={overview.kinds}
          locked={overview.locked.providers}
          onSaved={setOpen}
          onRemoved={() => {
            setOpen(null);
          }}
        />
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
          <ChatModelCard overview={overview} />
          <TranscriptionCard settings={transcription.data} />
        </Box>
      </Box>

      <EmbeddingsCard settings={embedding.data} />
    </Box>
  );
}

/** Every setting on this tab that an `HD_*` variable pins, by that variable. */
const lockedVariables = (
  overview: AiProvidersOverview,
  transcription: TranscriptionSettingsView,
  embedding: EmbeddingSettingsView,
): string[] => [
  ...(overview.locked.providers ? ['HD_AI_PROVIDERS'] : []),
  ...(overview.locked.defaults ? ['HD_AI_DEFAULT_PROVIDER', 'HD_AI_DEFAULT_MODEL'] : []),
  ...transcription.lockedKeys.map(envKeyOf),
  ...embedding.lockedKeys.map(envKeyOf),
];
