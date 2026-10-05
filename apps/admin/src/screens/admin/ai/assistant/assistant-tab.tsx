import { Box } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useId } from 'react';
import { Link as RouterLink } from 'react-router';
import { aiKeys } from '../../../../ai/api.js';
import { useAiApi } from '../../../../ai/context.tsx';
import { useT } from '../../../../app/i18n.js';
import { aiRoute } from '../../../../app/route-paths.js';
import { useSession } from '../../../../auth/session.tsx';
import { AlertBanner } from '../../../../ui/alert-banner.tsx';
import { ActivityCard } from './activity-card.tsx';
import { BudgetBanner } from './budget-banner.tsx';
import { BudgetCard } from './budget-card.tsx';
import { GuardrailsCard } from './guardrails-card.tsx';
import { ModesCard } from './modes-card.tsx';
import { PromptCard } from './prompt-card.tsx';

/**
 * AI › Assistant (`Admin/AI-Assistant`): the brand's modes, guardrails,
 * budget and system prompt, and its recent AI calls. The modes, guardrails and
 * budget are the Admin's (`brand:manage`); a Team Leader reads them and edits
 * the prompt (REQUIREMENTS §4.7). An install admin also sees the install's
 * state above them: no provider yet, or knowledge being reindexed.
 */
export function AssistantTab({ brandId }: { readonly brandId: string }): ReactNode {
  const t = useT();
  const api = useAiApi();
  const session = useSession();
  const limitId = useId();
  const canManage = session.user.role === 'admin';
  const settings = useQuery({
    queryKey: aiKeys.brand(brandId),
    queryFn: () => api.brandSettings(brandId),
  });

  if (settings.isError) {
    return <AlertBanner tone="danger">{t('aiSettings:loadFailed')}</AlertBanner>;
  }
  if (settings.data === undefined) {
    return <Box aria-busy="true" />;
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <BudgetBanner settings={settings.data} canRaise={canManage} limitInputId={limitId} />
      {session.user.installAdmin ? <InstallBanners /> : null}

      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: 'minmax(0, 1fr)', lg: 'minmax(0, 1fr) 360px' },
          gap: 6,
          alignItems: 'start',
        }}
      >
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
          <ModesCard brandId={brandId} settings={settings.data} canManage={canManage} />
          <GuardrailsCard brandId={brandId} settings={settings.data} canManage={canManage} />
          <PromptCard brandId={brandId} settings={settings.data} />
        </Box>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
          <BudgetCard
            brandId={brandId}
            settings={settings.data}
            canManage={canManage}
            limitInputId={limitId}
          />
          <ActivityCard brandId={brandId} />
        </Box>
      </Box>
    </Box>
  );
}

/** What only an install admin can know: whether there is a provider, and the index's state. */
function InstallBanners(): ReactNode {
  const t = useT();
  const api = useAiApi();
  const providers = useQuery({ queryKey: aiKeys.providers, queryFn: () => api.providers() });
  const embedding = useQuery({ queryKey: aiKeys.embedding, queryFn: () => api.embedding() });

  return (
    <>
      {providers.data?.providers.length === 0 ? (
        <AlertBanner tone="warning">
          {t('aiSettings:assistant.noProvider')}{' '}
          <RouterLink to={aiRoute('providers')}>{t('aiSettings:tabs.providers')}</RouterLink>
        </AlertBanner>
      ) : null}
      {embedding.data?.space.status === 'reindexing' ? (
        <AlertBanner tone="info">
          {t('aiSettings:assistant.reindexing')}{' '}
          <RouterLink to={aiRoute('providers')}>{t('aiSettings:assistant.seeProgress')}</RouterLink>
        </AlertBanner>
      ) : null}
    </>
  );
}
