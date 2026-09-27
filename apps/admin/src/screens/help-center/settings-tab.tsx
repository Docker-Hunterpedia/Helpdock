import type { HcAccess } from '@helpdock/schemas';
import { Box, Button, FormControlLabel, Radio, RadioGroup, Typography } from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { useT } from '../../app/i18n.js';
import { useSemanticTokens } from '../../app/tokens.js';
import { helpCenterKeys } from '../../help-center/api.js';
import { useToast } from '../../ui/toasts.tsx';
import { useHelpCenter, useHelpCenterReport } from './use-help-center.js';

/**
 * Help center › Settings, "Who can read it" (M5-09, `Admin/HelpCenter-Settings`
 * card 1): public, or signed-in staff only. The theme, home page and links
 * cards below it arrive with M5-06. A Viewer reads the choice and cannot change
 * it.
 */
export function SettingsTab({ canManage }: { readonly canManage: boolean }): ReactNode {
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
        maxWidth: 720,
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
