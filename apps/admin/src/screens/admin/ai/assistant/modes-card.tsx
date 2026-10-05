import {
  AI_AUTO_REPLY_CHANNELS,
  type AiAutoReplyChannel,
  type BrandAiModesUpdate,
  type BrandAiSettings,
} from '@helpdock/schemas';
import { Box, Button, TextField, Typography } from '@mui/material';
import { useQueryClient } from '@tanstack/react-query';
import { Mail, MessageCircle, OctagonX, Send, Workflow } from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useId, useState } from 'react';
import { Link as RouterLink } from 'react-router';
import { aiKeys } from '../../../../ai/api.js';
import { useAiApi } from '../../../../ai/context.tsx';
import { useT } from '../../../../app/i18n.js';
import { ROUTES, ticketingRoute } from '../../../../app/route-paths.js';
import { useSemanticTokens } from '../../../../app/tokens.js';
import { Field } from '../../../../ui/field.tsx';
import { SliderField } from '../../../../ui/slider-field.tsx';
import { Switch } from '../../../../ui/switch.tsx';
import { SectionCard } from '../../channels/section-card.tsx';
import { useAiAction } from '../use-ai-action.js';

/**
 * The Modes card of `Admin/AI-Assistant`: agent assist, auto-reply per channel
 * with its confidence threshold, whether an AI reply satisfies the first
 * response SLA, and the handoff message in both languages. Every mode starts
 * off. A Team Leader reads it; only an Admin saves it.
 */

const CHANNEL_ICONS = { widget: MessageCircle, email: Mail, telegram: Send } as const;
const ASSIST_FEATURES = [
  'suggest',
  'summarize',
  'triage',
  'translate',
  'rewrite',
  'draft',
] as const;

export const modesDraftOf = (settings: BrandAiSettings): BrandAiModesUpdate => ({
  ...settings.modes,
  aiCountsAsFirstResponse: settings.aiCountsAsFirstResponse,
});

export function ModesCard({
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
  const tokens = useSemanticTokens();
  const queryClient = useQueryClient();
  const id = useId();
  const [draft, setDraft] = useState<BrandAiModesUpdate>(() => modesDraftOf(settings));

  useEffect(() => {
    setDraft(modesDraftOf(settings));
  }, [settings]);

  const save = useAiAction(
    (request: BrandAiModesUpdate) => api.saveModes(brandId, request),
    t('aiSettings:modes.saved'),
    (saved) => {
      queryClient.setQueryData(aiKeys.brand(brandId), saved);
    },
  );
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    save.mutate({
      ...draft,
      handoffMessage: {
        en: draft.handoffMessage.en.trim(),
        ar: draft.handoffMessage.ar.trim(),
      },
    });
  };

  const setChannel = (
    channel: AiAutoReplyChannel,
    patch: Partial<BrandAiModesUpdate['autoReply'][AiAutoReplyChannel]>,
  ): void => {
    setDraft((held) => ({
      ...held,
      autoReply: { ...held.autoReply, [channel]: { ...held.autoReply[channel], ...patch } },
    }));
  };
  const hardStop = settings.usage.windows.some((window) => window.level === 'exceeded');
  const readOnly = !canManage;

  return (
    <SectionCard
      id={`${id}-modes`}
      heading={t('aiSettings:modes.heading')}
      caption={t('aiSettings:modes.caption')}
      onSubmit={submit}
      footer={
        readOnly ? (
          <Typography variant="caption" sx={{ color: 'text.secondary', marginInlineEnd: 'auto' }}>
            {t('aiSettings:adminOnly')}
          </Typography>
        ) : (
          <>
            <Button
              variant="text"
              disabled={save.isPending}
              onClick={() => {
                setDraft(modesDraftOf(settings));
              }}
            >
              {t('aiSettings:discard')}
            </Button>
            <Button type="submit" variant="contained" disabled={save.isPending}>
              {t('aiSettings:modes.save')}
            </Button>
          </>
        )
      }
    >
      <ModeRow
        title={t('aiSettings:modes.agentAssist')}
        body={t('aiSettings:modes.agentAssistBody')}
        control={
          <Switch
            checked={draft.agentAssist}
            label={t('aiSettings:modes.agentAssist')}
            disabled={readOnly}
            onChange={(agentAssist) => {
              setDraft((held) => ({ ...held, agentAssist }));
            }}
          />
        }
      >
        <Box
          component="ul"
          sx={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 2,
            margin: 0,
            padding: 0,
            listStyle: 'none',
          }}
        >
          {ASSIST_FEATURES.map((feature) => (
            <Box
              component="li"
              key={feature}
              sx={{
                fontSize: 12,
                paddingInline: 2,
                paddingBlock: 1,
                borderRadius: '6px',
                border: `1px solid ${tokens['border.default']}`,
                backgroundColor: tokens['bg.canvas'],
              }}
            >
              {t(`aiSettings:modes.features.${feature}`)}
            </Box>
          ))}
        </Box>
      </ModeRow>

      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        <Typography component="h3" sx={{ fontSize: 14, fontWeight: 600 }}>
          {t('aiSettings:modes.autoReply')}
        </Typography>
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          {t('aiSettings:modes.autoReplyBody')}
        </Typography>
      </Box>
      <Box
        role="table"
        aria-label={t('aiSettings:modes.autoReply')}
        sx={{
          border: `1px solid ${tokens['border.default']}`,
          borderRadius: '6px',
          overflow: 'hidden',
        }}
      >
        <Box role="rowgroup">
          <Box role="row" sx={{ ...rowGrid, backgroundColor: tokens['bg.muted'], minHeight: 36 }}>
            {(['channel', 'on', 'threshold', 'state'] as const).map((column) => (
              <Typography
                key={column}
                role="columnheader"
                variant="caption"
                sx={{ fontWeight: 500, color: 'text.secondary' }}
              >
                {t(`aiSettings:modes.columns.${column}`)}
              </Typography>
            ))}
          </Box>
        </Box>
        <Box role="rowgroup">
          {AI_AUTO_REPLY_CHANNELS.map((channel) => {
            const Icon = CHANNEL_ICONS[channel];
            const row = draft.autoReply[channel];
            const name = t(`aiSettings:channels.${channel}`);
            return (
              <Box
                role="row"
                key={channel}
                sx={{ ...rowGrid, borderBlockStart: `1px solid ${tokens['bg.muted']}` }}
              >
                <Typography
                  role="rowheader"
                  variant="body2"
                  sx={{ display: 'inline-flex', alignItems: 'center', gap: 2, fontWeight: 500 }}
                >
                  <Icon size={16} aria-hidden="true" />
                  {name}
                </Typography>
                <Box role="cell">
                  <Switch
                    checked={row.enabled}
                    label={t('aiSettings:modes.autoReplyOn', { channel: name })}
                    disabled={readOnly}
                    onChange={(enabled) => {
                      setChannel(channel, { enabled });
                    }}
                  />
                </Box>
                <Box role="cell" sx={{ minWidth: 0 }}>
                  {row.enabled ? (
                    <SliderField
                      value={row.threshold}
                      label={t('aiSettings:modes.threshold', { channel: name })}
                      disabled={readOnly}
                      onChange={(threshold) => {
                        setChannel(channel, { threshold });
                      }}
                    />
                  ) : (
                    <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                      {t('aiSettings:modes.offCaption')}
                    </Typography>
                  )}
                </Box>
                <Box role="cell">{row.enabled ? <ChannelState paused={hardStop} /> : null}</Box>
              </Box>
            );
          })}
        </Box>
      </Box>

      <ModeRow
        title={t('aiSettings:modes.firstResponse')}
        body={t('aiSettings:modes.firstResponseBody')}
        control={
          <Switch
            checked={draft.aiCountsAsFirstResponse}
            label={t('aiSettings:modes.firstResponse')}
            disabled={readOnly}
            onChange={(aiCountsAsFirstResponse) => {
              setDraft((held) => ({ ...held, aiCountsAsFirstResponse }));
            }}
          />
        }
      >
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          <RouterLink to={ticketingRoute('slas')}>{t('aiSettings:modes.slaLink')}</RouterLink>
        </Typography>
      </ModeRow>

      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        <Typography component="h3" sx={{ fontSize: 14, fontWeight: 600 }}>
          {t('aiSettings:modes.handoff')}
        </Typography>
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          {t('aiSettings:modes.handoffBody')}
        </Typography>
      </Box>
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 3 }}>
        {(['en', 'ar'] as const).map((language) => (
          <Field
            key={language}
            id={`${id}-handoff-${language}`}
            label={t(`aiSettings:languages.${language}`)}
            hint={t('aiSettings:modes.handoffHint')}
          >
            <TextField
              id={`${id}-handoff-${language}`}
              multiline
              minRows={3}
              size="small"
              value={draft.handoffMessage[language]}
              disabled={readOnly}
              onChange={(event) => {
                setDraft((held) => ({
                  ...held,
                  handoffMessage: { ...held.handoffMessage, [language]: event.target.value },
                }));
              }}
              slotProps={{
                htmlInput: {
                  lang: language,
                  dir: language === 'ar' ? 'rtl' : 'ltr',
                  maxLength: 1_000,
                },
              }}
            />
          </Field>
        ))}
      </Box>

      <Typography
        variant="caption"
        sx={{ color: 'text.secondary', display: 'inline-flex', alignItems: 'center', gap: 1 }}
      >
        <Workflow size={14} aria-hidden="true" />
        {t('aiSettings:modes.triageNote')}{' '}
        <RouterLink to={ROUTES.automation}>{t('admin:nav.automation')}</RouterLink>
      </Typography>
    </SectionCard>
  );
}

const rowGrid = {
  display: 'grid',
  gridTemplateColumns: '120px 56px minmax(0, 1fr) 128px',
  alignItems: 'center',
  gap: 3,
  paddingInline: 3,
  minHeight: 44,
} as const;

function ChannelState({ paused }: { readonly paused: boolean }): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();

  return paused ? (
    <Typography
      variant="caption"
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 1,
        paddingInline: 2,
        borderRadius: '6px',
        backgroundColor: tokens['status.danger.tint'],
        color: tokens['status.danger.text'],
        fontWeight: 500,
      }}
    >
      <OctagonX size={14} aria-hidden="true" />
      {t('aiSettings:modes.state.paused')}
    </Typography>
  ) : (
    <Typography variant="caption" sx={{ color: tokens['status.success.text'], fontWeight: 500 }}>
      {t('aiSettings:modes.state.active')}
    </Typography>
  );
}

function ModeRow({
  title,
  body,
  control,
  children,
}: {
  readonly title: string;
  readonly body: string;
  readonly control: ReactNode;
  readonly children?: ReactNode;
}): ReactNode {
  return (
    <Box sx={{ display: 'flex', gap: 3, alignItems: 'flex-start' }}>
      <Box sx={{ paddingBlockStart: '2px' }}>{control}</Box>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        <Typography component="h3" sx={{ fontSize: 14, fontWeight: 600 }}>
          {title}
        </Typography>
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          {body}
        </Typography>
        {children}
      </Box>
    </Box>
  );
}
