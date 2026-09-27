import type { HcAccess } from '@helpdock/schemas';
import { Box, Button, FormControlLabel, Radio, RadioGroup, Typography } from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { Link } from 'react-router';
import { useT } from '../../app/i18n.js';
import { brandRoute, channelsRoute } from '../../app/route-paths.js';
import { useSemanticTokens } from '../../app/tokens.js';
import { helpCenterKeys } from '../../help-center/api.js';
import { useToast } from '../../ui/toasts.tsx';
import { CustomCssCard } from './site/custom-css-card.tsx';
import { HomeCard } from './site/home-card.tsx';
import { LinksCard } from './site/links-card.tsx';
import { ThemeCard } from './site/theme-card.tsx';
import { useSite } from './site/use-site.js';
import { useHelpCenter, useHelpCenterReport } from './use-help-center.js';

/**
 * Help center › Settings (`Admin/HelpCenter-Settings`): "Who can read it"
 * (M5-09), then M5-06's Theme and Home page beside Header and footer links and
 * Custom CSS, and a note on where the rest lives. Every card saves on its own.
 * A Viewer reads them all and changes none.
 */
export function SettingsTab({ canManage }: { readonly canManage: boolean }): ReactNode {
  const site = useSite();
  const { structure } = useHelpCenter();

  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: { xs: 'minmax(0, 1fr)', xl: 'minmax(0, 1.2fr) minmax(0, 1fr)' },
        gap: 6,
        alignItems: 'start',
      }}
    >
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
        <AccessCard canManage={canManage} />
        {site.data === undefined ? null : (
          <>
            <ThemeCard appearance={site.data.appearance} canManage={canManage} />
            <HomeCard home={site.data.home} structure={structure.data} canManage={canManage} />
          </>
        )}
      </Box>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
        {site.data === undefined ? null : (
          <>
            <LinksCard links={site.data.links} canManage={canManage} />
            <CustomCssCard css={site.data.customCss} canManage={canManage} />
          </>
        )}
        <WhereTheRestLives />
      </Box>
    </Box>
  );
}

/** "Where the rest lives": the address on Brand › Domains, the widget's theme on Channels › Widget. */
function WhereTheRestLives(): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  return (
    <Box
      component="aside"
      aria-labelledby="hc-rest-heading"
      sx={{
        padding: 4,
        borderRadius: '10px',
        backgroundColor: tokens['bg.muted'],
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
        fontSize: 13,
      }}
    >
      <Typography id="hc-rest-heading" component="h2" sx={{ fontSize: 13, fontWeight: 600 }}>
        {t('helpCenter:site.rest.heading')}
      </Typography>
      <Typography sx={{ fontSize: 13 }}>
        {t('helpCenter:site.rest.address')}{' '}
        <Link to={brandRoute('domains')}>{t('helpCenter:site.rest.domains')}</Link>
      </Typography>
      <Typography sx={{ fontSize: 13 }}>
        {t('helpCenter:site.rest.widgetTheme')}{' '}
        <Link to={channelsRoute('widget')}>{t('helpCenter:site.rest.widget')}</Link>
      </Typography>
      <Typography sx={{ fontSize: 13, color: 'text.secondary' }}>
        {t('helpCenter:site.rest.cache')}
      </Typography>
    </Box>
  );
}

/** "Who can read it" (M5-09, card 1): public, or signed-in staff only. */
function AccessCard({ canManage }: { readonly canManage: boolean }): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const toast = useToast();
  const report = useHelpCenterReport();
  const queryClient = useQueryClient();
  const { brand, api } = useHelpCenter();
  const settings = useQuery({
    queryKey: helpCenterKeys.settings(brand.id),
    queryFn: () => api.settings(brand.id),
  });
  const [draft, setDraft] = useState<HcAccess | null>(null);
  const saved = settings.data?.access;
  const value = draft ?? saved ?? 'public';

  const save = useMutation({
    mutationFn: (access: HcAccess) => api.updateSettings(brand.id, { access }),
    onSuccess: (result) => {
      queryClient.setQueryData(helpCenterKeys.settings(brand.id), result);
      setDraft(null);
      toast({ tone: 'success', message: t('helpCenter:settings.saved') });
    },
    onError: report,
  });

  const option = (access: HcAccess) => (
    <FormControlLabel
      value={access}
      control={<Radio size="small" />}
      disabled={!canManage || save.isPending}
      sx={{ alignItems: 'flex-start', marginInlineStart: 0, gap: 1 }}
      label={
        <Box sx={{ display: 'flex', flexDirection: 'column', paddingBlockStart: '6px' }}>
          <Typography component="span" sx={{ fontSize: 14, fontWeight: 500 }}>
            {t(`helpCenter:settings.access.${access}.label`)}
          </Typography>
          <Typography
            component="span"
            variant="caption"
            sx={{ color: 'text.secondary', fontWeight: 400 }}
          >
            {t(`helpCenter:settings.access.${access}.hint`)}
          </Typography>
        </Box>
      }
    />
  );

  return (
    <Box
      component="section"
      aria-labelledby="hc-access-heading"
      sx={{
        borderRadius: '10px',
        border: `1px solid ${tokens['border.default']}`,
        backgroundColor: tokens['bg.surface'],
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <Box sx={{ padding: 5, display: 'flex', flexDirection: 'column', gap: 3 }}>
        <Box>
          <Typography variant="h3" component="h2" id="hc-access-heading">
            {t('helpCenter:settings.heading')}
          </Typography>
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            {t('helpCenter:settings.body')}
          </Typography>
        </Box>
        <RadioGroup
          aria-labelledby="hc-access-heading"
          value={value}
          onChange={(event) => {
            setDraft(event.target.value as HcAccess);
          }}
          sx={{ gap: 2 }}
        >
          {option('public')}
          {option('internal_only')}
        </RadioGroup>
      </Box>
      {canManage ? (
        <Box
          sx={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 2,
            paddingBlock: 3,
            paddingInline: 5,
            borderBlockStart: `1px solid ${tokens['border.default']}`,
            backgroundColor: tokens['bg.canvas'],
            borderEndStartRadius: '10px',
            borderEndEndRadius: '10px',
          }}
        >
          <Button
            variant="text"
            disabled={draft === null || draft === saved || save.isPending}
            onClick={() => {
              setDraft(null);
            }}
          >
            {t('helpCenter:settings.discard')}
          </Button>
          <Button
            variant="contained"
            disabled={draft === null || draft === saved || save.isPending}
            onClick={() => {
              save.mutate(value);
            }}
          >
            {t('helpCenter:settings.save')}
          </Button>
        </Box>
      ) : null}
    </Box>
  );
}
