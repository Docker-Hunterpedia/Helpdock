import type {
  CustomFieldDef,
  WidgetAppearance,
  WidgetConversationSettings,
  WidgetSettings,
} from '@helpdock/schemas';
import { Box, Button, Link as MuiLink, Typography } from '@mui/material';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy } from 'lucide-react';
import { type ReactNode, useEffect, useId, useMemo, useState } from 'react';
import { useT } from '../../../../app/i18n.js';
import { useSemanticTokens } from '../../../../app/tokens.js';
import {
  currentBrand,
  useChannelsApi,
  useSession,
  useTicketingApi,
} from '../../../../auth/session.tsx';
import { widgetKeys } from '../../../../channels/api.js';
import { AlertBanner } from '../../../../ui/alert-banner.tsx';
import { useToast } from '../../../../ui/toasts.tsx';
import { SectionCard } from '../section-card.tsx';
import { AccessCard } from './access-card.tsx';
import { AppearanceCard } from './appearance-card.tsx';
import { ContentPolicyCard } from './content-policy-card.tsx';
import { ConversationCard } from './conversation-card.tsx';
import { PROTOCOL_GUIDE_URL, SignedIdentityCard } from './signed-identity-card.tsx';
import { WidgetPreview } from './widget-preview.tsx';

/**
 * The one tag a site pastes (DESIGN §6.3 EmbedCode). The widget is served by
 * this install as an ES module (ADR 0012), and places itself for the brand in
 * `data-brand`.
 */
export const embedSnippet = (origin: string, brandId: string): string =>
  `<script type="module" src="${origin}/widget.js" data-brand="${brandId}"></script>`;

/**
 * Channels › Widget (artboard `AdminWidget`; M4-02, M4-03, M4-05 to M4-08).
 *
 * Admins see every card; a Team Leader sees Appearance, Conversation and
 * What visitors can send, because DOMAIN-RULES §1.2 gives them the widget's
 * theme and content policy and keeps where it runs and who it trusts with
 * the Admin. The api answers a Team Leader's read with the Admin cards
 * empty, so hiding them here is manners, not the rule.
 */
export function WidgetTab(): ReactNode {
  const t = useT();
  const api = useChannelsApi();
  const ticketing = useTicketingApi();
  const session = useSession();
  const brand = currentBrand(session);
  const queryClient = useQueryClient();

  const settings = useQuery({
    queryKey: widgetKeys.settings(brand.id),
    queryFn: () => api.widgetSettings(brand.id),
  });
  const customFields = useQuery({
    queryKey: ['custom-fields', brand.id, 'ticket'],
    queryFn: () => ticketing.customFields(brand.id, 'ticket'),
  });

  const saved = (next: WidgetSettings): void => {
    queryClient.setQueryData(widgetKeys.settings(brand.id), next);
  };

  if (settings.isError) {
    return <AlertBanner tone="danger">{t('channels:widget.loadFailed')}</AlertBanner>;
  }
  if (settings.data === undefined) {
    return <Box aria-busy="true" />;
  }

  return (
    <WidgetCards
      brandId={brand.id}
      brandName={brand.name}
      isAdmin={session.user.role === 'admin'}
      settings={settings.data}
      customFields={customFields.data?.fields ?? []}
      onSaved={saved}
      onReplaced={() => queryClient.invalidateQueries({ queryKey: widgetKeys.settings(brand.id) })}
    />
  );
}

function WidgetCards({
  brandId,
  brandName,
  isAdmin,
  settings,
  customFields,
  onSaved,
  onReplaced,
}: {
  readonly brandId: string;
  readonly brandName: string;
  readonly isAdmin: boolean;
  readonly settings: WidgetSettings;
  readonly customFields: readonly CustomFieldDef[];
  readonly onSaved: (settings: WidgetSettings) => void;
  readonly onReplaced: () => Promise<void>;
}): ReactNode {
  const [appearance, setAppearance] = useState<WidgetAppearance>(settings.appearance);
  const [conversation, setConversation] = useState<WidgetConversationSettings>(
    settings.conversation,
  );
  useEffect(() => setAppearance(settings.appearance), [settings.appearance]);
  useEffect(() => setConversation(settings.conversation), [settings.conversation]);

  const customLabels = useMemo(
    () => new Map(customFields.map((def) => [def.key, { en: def.label, ar: def.labelAr }])),
    [customFields],
  );
  const twoColumns = { xs: 'minmax(0, 1fr)', xl: 'minmax(0, 1fr) minmax(0, 1fr)' };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <EmbedCard brandId={brandId} />

      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: 'minmax(0, 1fr)', xl: 'minmax(0, 1fr) 420px' },
          gap: 6,
          alignItems: 'start',
        }}
      >
        <AppearanceCard
          brandId={brandId}
          draft={appearance}
          saved={settings.appearance}
          onChange={setAppearance}
          onSaved={onSaved}
        />
        <WidgetPreview
          appearance={appearance}
          conversation={conversation}
          brandName={brandName}
          customLabels={customLabels}
        />
      </Box>

      <Box sx={{ display: 'grid', gridTemplateColumns: twoColumns, gap: 6, alignItems: 'start' }}>
        <ConversationCard
          brandId={brandId}
          draft={conversation}
          saved={settings.conversation}
          customFields={customFields}
          onChange={setConversation}
          onSaved={onSaved}
        />
        <ContentPolicyCard brandId={brandId} policy={settings.contentPolicy} onSaved={onSaved} />
      </Box>

      {isAdmin && settings.access !== null && settings.signedIdentity !== null ? (
        <Box sx={{ display: 'grid', gridTemplateColumns: twoColumns, gap: 6, alignItems: 'start' }}>
          <AccessCard brandId={brandId} access={settings.access} onSaved={onSaved} />
          <SignedIdentityCard
            brandId={brandId}
            signed={settings.signedIdentity}
            onSaved={onSaved}
            onReplaced={onReplaced}
          />
        </Box>
      ) : null}
    </Box>
  );
}

function EmbedCard({ brandId }: { readonly brandId: string }): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const toast = useToast();
  const id = useId();
  const snippet = embedSnippet(window.location.origin, brandId);

  return (
    <SectionCard
      id={`${id}-embed`}
      heading={t('channels:widget.embed.heading')}
      caption={t('channels:widget.embed.caption')}
      aside={
        <Button
          variant="outlined"
          size="small"
          startIcon={<Copy size={14} aria-hidden="true" />}
          onClick={() => {
            void navigator.clipboard.writeText(snippet).then(
              () => toast({ tone: 'success', message: t('channels:widget.embed.copied') }),
              () => toast({ tone: 'danger', message: t('channels:actionFailed') }),
            );
          }}
        >
          {t('channels:widget.embed.copy')}
        </Button>
      }
    >
      <Box
        component="pre"
        aria-label={t('channels:widget.embed.label')}
        dir="ltr"
        tabIndex={0}
        sx={{
          margin: 0,
          paddingBlock: 3,
          paddingInline: '14px',
          borderRadius: '6px',
          backgroundColor: tokens['bg.muted'],
          fontFamily: 'var(--hd-font-mono, monospace)',
          fontSize: 13,
          lineHeight: '20px',
          whiteSpace: 'pre',
          overflowX: 'auto',
        }}
      >
        {snippet}
      </Box>
      <Typography variant="caption" sx={{ color: 'text.secondary' }}>
        {t('channels:widget.embed.hint')} {t('channels:widget.embed.protocol')}{' '}
        <MuiLink href={PROTOCOL_GUIDE_URL} target="_blank" rel="noreferrer">
          {t('channels:widget.embed.protocolLink')}
        </MuiLink>
      </Typography>
    </SectionCard>
  );
}
