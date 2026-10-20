import { Box, Button, Typography } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useT } from '../../../app/i18n.js';
import { useSemanticTokens } from '../../../app/tokens.js';
import { currentBrand, useSession } from '../../../auth/session.tsx';
import { automationKeys } from '../../../automation/api.js';
import { useAutomationApi } from '../../../automation/context.tsx';
import { AlertBanner } from '../../../ui/alert-banner.tsx';
import { RoutingSteps } from './routing-steps.tsx';
import { useRuleText } from './rule-text.js';
import { TestRoutingPanel } from './test-routing-panel.tsx';

/**
 * The Routing tab of Admin › Automation (M14-09, `Admin/Automation-Routing`):
 * the four steps a new ticket goes through, beside Test routing, which walks
 * a sample message through them without writing anything.
 *
 * The explainer is the reader's own view: a Team Leader's scope shortens the
 * doors and the departments the api returns, so nothing here filters.
 */
export function RoutingTab(): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const brand = currentBrand(useSession());
  const api = useAutomationApi();

  const overview = useQuery({
    queryKey: automationKeys.routing(brand.id),
    queryFn: () => api.routing(brand.id),
  });
  const options = useQuery({
    queryKey: automationKeys.options(brand.id),
    queryFn: () => api.options(brand.id),
  });
  const text = useRuleText(options.data);

  if (overview.isError) {
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3, alignItems: 'flex-start' }}>
        <AlertBanner tone="danger">{t('rules:routing.failed')}</AlertBanner>
        <Button
          variant="outlined"
          onClick={() => {
            void overview.refetch();
          }}
        >
          {t('rules:routing.retry')}
        </Button>
      </Box>
    );
  }

  if (overview.data === undefined) {
    return (
      <Typography
        role="status"
        aria-busy="true"
        variant="body2"
        sx={{ color: tokens['text.secondary'] }}
      >
        {t('rules:routing.loading')}
      </Typography>
    );
  }

  return (
    <Box
      sx={{
        display: 'grid',
        gap: 6,
        alignItems: 'start',
        gridTemplateColumns: { xs: 'minmax(0, 1fr)', lg: 'repeat(2, minmax(0, 1fr))' },
      }}
    >
      <RoutingSteps overview={overview.data} text={text} />
      <TestRoutingPanel overview={overview.data} options={options.data} text={text} />
    </Box>
  );
}
