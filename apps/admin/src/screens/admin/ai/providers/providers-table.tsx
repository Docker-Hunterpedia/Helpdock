import type { AiProvidersOverview, AiProviderView } from '@helpdock/schemas';
import {
  Box,
  Button,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import { KeyRound, LogIn, Plus, Server } from 'lucide-react';
import type { ReactNode } from 'react';
import { useT } from '../../../../app/i18n.js';
import { usePreferences } from '../../../../app/providers.tsx';
import { useSemanticTokens } from '../../../../app/tokens.js';
import { EnvChip } from '../../../../ui/env-locked-field.tsx';
import { visuallyHidden } from '../../../../ui/visually-hidden.js';
import { SectionCard } from '../../channels/section-card.tsx';
import { dayOf, kindLabel } from '../format.js';

/**
 * The Providers card of `Admin/AI-Providers`: one row per provider with its
 * kind, the kind of credential it holds — never the credential — and which
 * one is the install default. "Edit" opens the row in the form below.
 */
export function ProvidersTable({
  overview,
  selected,
  onOpen,
  onAdd,
}: {
  readonly overview: AiProvidersOverview;
  readonly selected: string | null;
  onOpen(providerId: string): void;
  onAdd(): void;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();

  return (
    <SectionCard
      id="ai-providers"
      heading={t('aiSettings:providers.heading')}
      caption={t('aiSettings:providers.caption')}
      aside={
        overview.locked.providers ? (
          <EnvChip />
        ) : (
          <Button
            variant="contained"
            startIcon={<Plus size={16} aria-hidden="true" />}
            onClick={onAdd}
          >
            {t('aiSettings:providers.add')}
          </Button>
        )
      }
    >
      <Box sx={{ marginInline: -5, marginBlock: -5, overflowX: 'auto' }}>
        <Table size="small" aria-label={t('aiSettings:providers.tableLabel')}>
          <TableHead>
            <TableRow sx={{ backgroundColor: tokens['bg.muted'] }}>
              <TableCell>{t('aiSettings:providers.columns.provider')}</TableCell>
              <TableCell>{t('aiSettings:providers.columns.credential')}</TableCell>
              <TableCell>
                <Box component="span" sx={visuallyHidden}>
                  {t('aiSettings:providers.columns.actions')}
                </Box>
              </TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {overview.providers.map((provider) => (
              <ProviderRow
                key={provider.id}
                provider={provider}
                isDefault={overview.defaults.providerId === provider.id}
                lockedByEnv={overview.locked.providers}
                open={provider.id === selected}
                onOpen={() => {
                  onOpen(provider.id);
                }}
              />
            ))}
          </TableBody>
        </Table>
      </Box>
      <Typography variant="caption" sx={{ color: 'text.secondary', paddingBlockStart: 4 }}>
        {t('aiSettings:providers.footer')}
      </Typography>
    </SectionCard>
  );
}

function ProviderRow({
  provider,
  isDefault,
  lockedByEnv,
  open,
  onOpen,
}: {
  readonly provider: AiProviderView;
  readonly isDefault: boolean;
  readonly lockedByEnv: boolean;
  readonly open: boolean;
  onOpen(): void;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const Icon =
    provider.authType === 'oauth' ? LogIn : provider.authType === 'apiKey' ? KeyRound : Server;

  return (
    <TableRow
      sx={{
        backgroundColor: open ? tokens['action.primary.tint'] : undefined,
        boxShadow: open ? `inset 3px 0 0 ${tokens['action.primary']}` : undefined,
      }}
    >
      <TableCell>
        <Box sx={{ display: 'flex', flexDirection: 'column' }}>
          <Typography sx={{ fontSize: 13, fontWeight: 500 }}>
            {provider.label}
            {isDefault ? (
              <Typography
                component="span"
                variant="caption"
                sx={{ color: 'text.secondary', marginInlineStart: 2 }}
              >
                {t('aiSettings:providers.default')}
              </Typography>
            ) : null}
          </Typography>
          <Typography variant="caption" sx={{ color: 'text.secondary' }} dir="auto">
            {provider.baseUrl ?? kindLabel(t, provider.kind)}
          </Typography>
        </Box>
      </TableCell>
      <TableCell>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
          <Box
            component="span"
            sx={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 1,
              paddingInline: 2,
              height: 20,
              borderRadius: '6px',
              backgroundColor: tokens['bg.muted'],
              fontSize: 12,
            }}
          >
            <Icon size={14} aria-hidden="true" />
            {t(`aiSettings:credential.${provider.authType}`)}
          </Box>
          {lockedByEnv ? (
            <>
              <EnvChip />
              <Typography
                variant="mono"
                component="span"
                sx={{ fontSize: 12, color: 'text.secondary' }}
              >
                HD_AI_PROVIDERS
              </Typography>
            </>
          ) : (
            <CredentialHint provider={provider} />
          )}
        </Box>
      </TableCell>
      <TableCell sx={{ textAlign: 'end' }}>
        <Button
          size="small"
          variant="outlined"
          onClick={onOpen}
          aria-label={t('aiSettings:providers.edit', { name: provider.label })}
        >
          {t('aiSettings:providers.editShort')}
        </Button>
      </TableCell>
    </TableRow>
  );
}

function CredentialHint({ provider }: { readonly provider: AiProviderView }): ReactNode {
  const t = useT();
  const { locale } = usePreferences();

  if (provider.authType === 'apiKey') {
    return (
      <Typography variant="mono" component="span" sx={{ fontSize: 12, color: 'text.secondary' }}>
        ••••••••
      </Typography>
    );
  }
  if (provider.authType === 'oauth' && provider.oauthExpiresAt !== null) {
    return (
      <Typography variant="caption" sx={{ color: 'text.secondary' }}>
        {t('aiSettings:credential.oauthExpires', {
          date: dayOf(new Date(provider.oauthExpiresAt), locale),
        })}
      </Typography>
    );
  }
  return null;
}
