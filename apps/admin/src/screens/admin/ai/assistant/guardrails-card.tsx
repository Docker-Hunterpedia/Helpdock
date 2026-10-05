import type { BrandAiSettings } from '@helpdock/schemas';
import { Box, Typography } from '@mui/material';
import { useQueryClient } from '@tanstack/react-query';
import { Ban, FileText, Lock, type LucideIcon, Shield } from 'lucide-react';
import { type ReactNode, useId } from 'react';
import { aiKeys } from '../../../../ai/api.js';
import { useAiApi } from '../../../../ai/context.tsx';
import { useT } from '../../../../app/i18n.js';
import { useSemanticTokens } from '../../../../app/tokens.js';
import { Switch } from '../../../../ui/switch.tsx';
import { SectionCard } from '../../channels/section-card.tsx';
import { settingsUpdateOf } from '../settings-update.js';
import { useAiAction } from '../use-ai-action.js';

/**
 * The Guardrails card of `Admin/AI-Assistant`. PII redaction, no tools and the
 * call log are fixed for every brand and say so; the injection filter is the
 * one the Admin may turn off, and it saves on the switch.
 */

export function GuardrailsCard({
  brandId,
  settings,
  canManage,
}: {
  readonly brandId: string;
  readonly settings: BrandAiSettings;
  readonly canManage: boolean;
}): ReactNode {
  const t = useT();
  const api = useAiApi();
  const queryClient = useQueryClient();
  const id = useId();
  const save = useAiAction(
    (injectionFilter: boolean) =>
      api.saveBrandSettings(brandId, {
        ...settingsUpdateOf(settings),
        piiRedaction: true,
        injectionFilter,
      }),
    t('aiSettings:guardrails.saved'),
    (saved) => {
      queryClient.setQueryData(aiKeys.brand(brandId), saved);
    },
  );

  return (
    <SectionCard
      id={`${id}-guardrails`}
      heading={t('aiSettings:guardrails.heading')}
      caption={t('aiSettings:guardrails.caption')}
    >
      <Box
        component="ul"
        sx={{
          listStyle: 'none',
          margin: 0,
          padding: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
        }}
      >
        <Guardrail icon={Shield} name="pii" fixed="alwaysOn" />
        <Guardrail
          icon={Shield}
          name="injection"
          control={
            <Switch
              checked={settings.injectionFilter}
              label={t('aiSettings:guardrails.injection.title')}
              disabled={!canManage || save.isPending}
              onChange={(next) => {
                save.mutate(next);
              }}
            />
          }
        />
        <Guardrail icon={Ban} name="noTools" fixed="fixedInV1" />
        <Guardrail icon={FileText} name="logged" fixed="alwaysOn" />
      </Box>
    </SectionCard>
  );
}

function Guardrail({
  icon: Icon,
  name,
  fixed,
  control,
}: {
  readonly icon: LucideIcon;
  readonly name: 'pii' | 'injection' | 'noTools' | 'logged';
  readonly fixed?: 'alwaysOn' | 'fixedInV1';
  readonly control?: ReactNode;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();

  return (
    <Box component="li" sx={{ display: 'flex', gap: 3, alignItems: 'flex-start' }}>
      <Box
        aria-hidden="true"
        sx={{
          width: 28,
          height: 28,
          flexShrink: 0,
          borderRadius: '6px',
          display: 'grid',
          placeItems: 'center',
          backgroundColor: tokens['bg.muted'],
        }}
      >
        <Icon size={14} />
      </Box>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, flex: 1, minWidth: 0 }}>
        <Typography component="h3" sx={{ fontSize: 14, fontWeight: 600 }}>
          {t(`aiSettings:guardrails.${name}.title`)}
        </Typography>
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          {t(`aiSettings:guardrails.${name}.body`)}
        </Typography>
      </Box>
      {control}
      {fixed === undefined ? null : (
        <Typography
          variant="caption"
          sx={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 1,
            paddingInline: 2,
            borderRadius: '6px',
            border: `1px solid ${tokens['border.default']}`,
            whiteSpace: 'nowrap',
          }}
        >
          <Lock size={14} aria-hidden="true" />
          {t(`aiSettings:guardrails.${fixed}`)}
        </Typography>
      )}
    </Box>
  );
}
