import { NAMESPACES } from '@helpdock/i18n';
import type { WidgetAppearance, WidgetConversationSettings } from '@helpdock/schemas';
import { resolveBrandTheme, resolveSemanticTokens } from '@helpdock/ui';
import { Box, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import { MessageCircle, Minus } from 'lucide-react';
import { type ReactNode, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useT } from '../../../../app/i18n.js';
import { usePreferences } from '../../../../app/providers.tsx';
import { useSemanticTokens } from '../../../../app/tokens.js';
import { checkAccent } from './widget-draft.js';

/**
 * The Appearance card's live preview (artboard `AdminWidget`, DESIGN §6.6):
 * the widget window as a visitor would see it with the *unsaved* draft —
 * header in the accent, the greeting, the pre-chat form, the launcher — in
 * either language and either theme, whatever the admin itself is in.
 *
 * It is a picture, not the widget: nothing in it is focusable or sends
 * anything, so it is one labelled image-like region to a screen reader, and
 * the real widget is built by M4-01 from the same tokens.
 */
export function WidgetPreview({
  appearance,
  conversation,
  brandName,
  customLabels,
}: {
  readonly appearance: WidgetAppearance;
  readonly conversation: WidgetConversationSettings;
  readonly brandName: string;
  /** Custom pre-chat fields' labels by key, in each language. */
  readonly customLabels: ReadonlyMap<string, { readonly en: string; readonly ar: string | null }>;
}): ReactNode {
  const t = useT();
  const admin = useSemanticTokens();
  const headingId = useId();
  const { locale: adminLocale } = usePreferences();
  // It opens in the admin's own language; the toggle shows the other one.
  const [locale, setLocale] = useState<'en' | 'ar'>(adminLocale);
  const [mode, setMode] = useState<'light' | 'dark'>('light');
  const surface = useMemo(() => resolveSemanticTokens(mode), [mode]);
  const { i18n } = useTranslation(NAMESPACES);
  // The preview speaks the visitor's language, whatever the admin is in.
  const w = useMemo(() => i18n.getFixedT(locale, 'channels'), [i18n, locale]);

  const accentHex =
    checkAccent(appearance.accent).kind === 'invalid' ? '#0F766E' : appearance.accent.trim();
  const accent = resolveBrandTheme({ accent: accentHex, mode: 'auto' }).accent[mode];
  const greeting =
    locale === 'ar' && appearance.greetingAr.trim() !== ''
      ? appearance.greetingAr
      : appearance.greetingEn;
  const fields = conversation.prechatEnabled ? conversation.prechatFields : [];
  const labelOf = (key: string): string => {
    if (key === 'name') {
      return w('widget.preview.name');
    }
    if (key === 'email') {
      return w('widget.preview.email');
    }
    const label = customLabels.get(key);
    return (locale === 'ar' ? label?.ar : null) ?? label?.en ?? key;
  };
  const dir = locale === 'ar' ? 'rtl' : 'ltr';
  const launcherAtStart = appearance.position === 'start';

  return (
    <Box
      component="aside"
      aria-labelledby={headingId}
      sx={{
        borderRadius: '10px',
        border: `1px solid ${admin['border.default']}`,
        backgroundColor: admin['bg.surface'],
        padding: 5,
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
        position: { xl: 'sticky' },
        insetBlockStart: 24,
      }}
    >
      <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 2 }}>
        <Typography
          id={headingId}
          variant="h3"
          component="h2"
          sx={{ fontSize: 16, flex: '1 1 auto' }}
        >
          {t('channels:widget.preview.heading')}
        </Typography>
        <ToggleButtonGroup
          size="small"
          exclusive
          value={locale}
          aria-label={t('channels:widget.preview.language')}
          onChange={(_event, value: 'en' | 'ar' | null) => {
            if (value !== null) {
              setLocale(value);
            }
          }}
        >
          <ToggleButton value="en">English</ToggleButton>
          <ToggleButton value="ar">
            <span lang="ar">العربية</span>
          </ToggleButton>
        </ToggleButtonGroup>
        <ToggleButtonGroup
          size="small"
          exclusive
          value={mode}
          aria-label={t('channels:widget.preview.theme')}
          onChange={(_event, value: 'light' | 'dark' | null) => {
            if (value !== null) {
              setMode(value);
            }
          }}
        >
          <ToggleButton value="light">{t('channels:widget.preview.light')}</ToggleButton>
          <ToggleButton value="dark">{t('channels:widget.preview.dark')}</ToggleButton>
        </ToggleButtonGroup>
      </Box>
      <Typography variant="caption" sx={{ color: 'text.secondary' }}>
        {t('channels:widget.preview.caption')}
      </Typography>

      <Box
        role="img"
        aria-label={t('channels:widget.preview.region')}
        dir={dir}
        lang={locale}
        sx={{
          borderRadius: '10px',
          backgroundColor: surface['bg.canvas'],
          padding: 4,
          display: 'flex',
          flexDirection: 'column',
          alignItems: launcherAtStart ? 'flex-start' : 'flex-end',
          gap: 3,
        }}
      >
        <Box
          sx={{
            width: '100%',
            maxWidth: 340,
            borderRadius: '16px',
            overflow: 'hidden',
            backgroundColor: surface['bg.surface'],
            border: `1px solid ${surface['border.default']}`,
            boxShadow: '0 8px 24px rgba(22, 24, 28, 0.16)',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <Box
            sx={{
              backgroundColor: accent.base,
              color: accent.text,
              paddingBlock: 3,
              paddingInline: 4,
              display: 'flex',
              alignItems: 'center',
              gap: 3,
            }}
          >
            <Box
              aria-hidden="true"
              sx={{
                width: 32,
                height: 32,
                borderRadius: '50%',
                display: 'grid',
                placeItems: 'center',
                backgroundColor: 'rgba(255, 255, 255, 0.2)',
                fontWeight: 600,
              }}
            >
              {brandName.slice(0, 1).toUpperCase()}
            </Box>
            <Box sx={{ display: 'flex', flexDirection: 'column', flex: '1 1 auto', minWidth: 0 }}>
              <Typography sx={{ fontSize: 14, fontWeight: 600, color: 'inherit' }}>
                {w('widget.preview.team', { brand: brandName })}
              </Typography>
              <Typography sx={{ fontSize: 12, color: 'inherit' }}>
                {w('widget.preview.replies')}
              </Typography>
            </Box>
            <Minus size={16} aria-hidden="true" />
          </Box>

          <Box sx={{ padding: 4, display: 'flex', flexDirection: 'column', gap: 3 }}>
            <Box
              sx={{
                alignSelf: 'flex-start',
                maxWidth: '85%',
                paddingBlock: 2,
                paddingInline: 3,
                borderRadius: '14px',
                borderEndStartRadius: '4px',
                backgroundColor: surface['bg.surface'],
                border: `1px solid ${surface['border.default']}`,
                color: surface['text.primary'],
                fontSize: 14,
              }}
            >
              <bdi>{greeting}</bdi>
            </Box>

            {fields.length === 0 ? null : (
              <Box
                sx={{
                  borderRadius: '10px',
                  border: `1px solid ${surface['border.default']}`,
                  backgroundColor: surface['bg.canvas'],
                  padding: 3,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 2,
                }}
              >
                <Typography sx={{ fontSize: 13, fontWeight: 600, color: surface['text.primary'] }}>
                  {w('widget.preview.beforeStart')}
                </Typography>
                {fields.map((field) => {
                  const key = field.kind === 'custom' ? field.key : field.kind;
                  return (
                    <Box key={key} sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                      <Typography
                        sx={{ fontSize: 12, fontWeight: 500, color: surface['text.primary'] }}
                      >
                        {labelOf(key)}
                        {field.required ? null : (
                          <Box component="span" sx={{ color: surface['text.secondary'] }}>
                            {' '}
                            {w('widget.preview.optional')}
                          </Box>
                        )}
                      </Typography>
                      <Box
                        sx={{
                          height: 32,
                          borderRadius: '6px',
                          border: `1px solid ${surface['border.strong']}`,
                          backgroundColor: surface['bg.surface'],
                        }}
                      />
                    </Box>
                  );
                })}
                <Box
                  sx={{
                    height: 36,
                    borderRadius: '6px',
                    backgroundColor: accent.base,
                    color: accent.text,
                    display: 'grid',
                    placeItems: 'center',
                    fontSize: 14,
                    fontWeight: 500,
                  }}
                >
                  {w('widget.preview.start')}
                </Box>
              </Box>
            )}
          </Box>
          <Typography
            sx={{
              fontSize: 11,
              color: surface['text.secondary'],
              textAlign: 'center',
              paddingBlockEnd: 2,
            }}
          >
            {w('widget.preview.powered')}
          </Typography>
        </Box>

        <Box
          sx={{
            height: 56,
            minWidth: 56,
            paddingInline: appearance.launcher === 'icon' ? 0 : 4,
            borderRadius: '999px',
            backgroundColor: accent.base,
            color: accent.text,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 2,
            fontSize: 14,
            fontWeight: 500,
            boxShadow: '0 4px 12px rgba(22, 24, 28, 0.16)',
          }}
        >
          {appearance.launcher === 'text' ? null : <MessageCircle size={24} aria-hidden="true" />}
          {appearance.launcher === 'icon' ? null : w('widget.preview.launcherText')}
        </Box>
      </Box>
    </Box>
  );
}
