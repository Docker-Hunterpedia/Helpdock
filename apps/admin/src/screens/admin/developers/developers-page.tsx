import { Box, Button, Tab, Tabs } from '@mui/material';
import { BookOpen, KeyRound, Plus, Webhook } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router';
import { useT } from '../../../app/i18n.js';
import { developersRoute } from '../../../app/route-paths.js';
import { useSemanticTokens } from '../../../app/tokens.js';
import { currentBrand, useSession } from '../../../auth/session.tsx';
import { PageHeader } from '../../../shell/page-header.tsx';
import { ApiKeysTab } from './api-keys-tab.tsx';
import { WebhooksTab } from './webhooks-tab.tsx';

/**
 * `Admin/Developers` (M8-01, M8-03): **API keys** (`Admin/Developers-ApiKeys`)
 * and **Webhooks** (`Admin/Developers-Webhooks`). Admin only — a key or an
 * endpoint acts for the whole brand, so both routes need `brand:manage`.
 *
 * The header's primary action belongs to the open tab: "Create API key" or
 * "Add endpoint". The page owns the open/closed state of that one dialog so
 * the header and the tab's empty state open the same thing.
 */

export const DEVELOPERS_TABS = [
  { key: 'apiKeys', segment: 'api-keys', icon: KeyRound },
  { key: 'webhooks', segment: 'webhooks', icon: Webhook },
] as const;

/** The OpenAPI 3.1 document and its reference page, served by the api (M8-02). */
export const API_DOCS_PATH = '/api/docs';

export function DevelopersPage(): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const brand = currentBrand(useSession());
  const { tab: segment } = useParams();
  const [creating, setCreating] = useState(false);

  const tab = DEVELOPERS_TABS.find((candidate) => candidate.segment === segment);
  if (tab === undefined) {
    return <Navigate to={developersRoute(DEVELOPERS_TABS[0].segment)} replace />;
  }

  const close = (): void => {
    setCreating(false);
  };
  const open = (): void => {
    setCreating(true);
  };

  return (
    <>
      <PageHeader
        title={t('developers:title')}
        caption={t('developers:subtitle', { brand: brand.name })}
        action={
          <Box sx={{ display: 'flex', gap: 2, flexShrink: 0 }}>
            <Button
              variant="outlined"
              color="inherit"
              href={API_DOCS_PATH}
              target="_blank"
              rel="noopener"
              aria-label={t('developers:apiDocsLabel')}
              startIcon={<BookOpen size={16} aria-hidden="true" />}
            >
              {t('developers:apiDocs')}
            </Button>
            <Button
              variant="contained"
              startIcon={<Plus size={16} aria-hidden="true" />}
              onClick={open}
            >
              {t(tab.key === 'apiKeys' ? 'developers:keys.create' : 'developers:webhooks.add')}
            </Button>
          </Box>
        }
      />

      <Box sx={{ borderBlockEnd: `1px solid ${tokens['border.default']}`, marginBlockEnd: 6 }}>
        <Tabs value={tab.key} aria-label={t('developers:tabList')}>
          {DEVELOPERS_TABS.map((candidate) => (
            <Tab
              key={candidate.key}
              value={candidate.key}
              label={t(`developers:tabs.${candidate.key}`)}
              icon={<candidate.icon size={14} aria-hidden="true" />}
              iconPosition="start"
              component={Link}
              to={developersRoute(candidate.segment)}
              onClick={close}
              sx={{ minHeight: 44 }}
            />
          ))}
        </Tabs>
      </Box>

      {tab.key === 'apiKeys' ? (
        <ApiKeysTab creating={creating} onCreate={open} onCreateClose={close} />
      ) : (
        <WebhooksTab adding={creating} onAdd={open} onAddClose={close} />
      )}
    </>
  );
}
