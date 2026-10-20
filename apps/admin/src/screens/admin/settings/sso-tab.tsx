import type { SsoSettings, SsoTargets } from '@helpdock/schemas';
import {
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  FormControlLabel,
  Link,
  MenuItem,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Plus } from 'lucide-react';
import { useState } from 'react';
import { Link as RouterLink } from 'react-router';
import { useT } from '../../../app/i18n.js';
import { usePreferences } from '../../../app/providers.tsx';
import { ssoConnectionRoute } from '../../../app/route-paths.js';
import { EmptyState } from '../../../shell/empty-state.js';
import { ssoKeys } from '../../../sso/api.js';
import { useSsoApi } from '../../../sso/context.tsx';
import { AlertBanner } from '../../../ui/alert-banner.tsx';
import { latinNumbering } from '../../../ui/format.js';
import { useToast } from '../../../ui/toasts.tsx';
import { SectionCard } from '../channels/section-card.tsx';
import { SsoPublicValue } from './sso-public-value.tsx';

/** Admin/Settings-SSO, with the existing SectionCard and Table components. */
export function SsoTab() {
  const t = useT();
  const api = useSsoApi();
  const { locale } = usePreferences();
  const connections = useQuery({ queryKey: ssoKeys.connections, queryFn: () => api.connections() });
  const settings = useQuery({ queryKey: ssoKeys.settings, queryFn: () => api.settings() });
  const targets = useQuery({ queryKey: ssoKeys.targets, queryFn: () => api.targets() });
  if (connections.isPending || settings.isPending || targets.isPending)
    return (
      <Box role="status">
        <CircularProgress size={20} aria-hidden="true" />
        {t('common:loading')}
      </Box>
    );
  if (!connections.data || !settings.data || !targets.data)
    return <AlertBanner tone="danger">{t('sso:error')}</AlertBanner>;
  const add = (
    <Button
      component={RouterLink}
      to={ssoConnectionRoute('new')}
      variant="contained"
      startIcon={<Plus size={16} aria-hidden="true" />}
    >
      {t('sso:add')}
    </Button>
  );
  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: { xs: 'minmax(0, 1fr)', lg: 'minmax(0, 1fr) 320px' },
        gap: 8,
        alignItems: 'start',
      }}
    >
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
        <SectionCard
          id="sso-providers"
          heading={t('sso:providers')}
          caption={t('sso:providersHint')}
          aside={add}
        >
          {connections.data.connections.length === 0 ? (
            <EmptyState icon={KeyRound} heading={t('sso:empty')} body={t('sso:emptyHint')} />
          ) : (
            <TableContainer>
              <Table aria-label={t('sso:providers')}>
                <TableHead>
                  <TableRow>
                    <TableCell>{t('sso:name')}</TableCell>
                    <TableCell>{t('sso:protocol')}</TableCell>
                    <TableCell>{t('sso:domains')}</TableCell>
                    <TableCell>{t('sso:people')}</TableCell>
                    <TableCell>{t('sso:lastSignIn')}</TableCell>
                    <TableCell>{t('sso:status')}</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {connections.data.connections.map((connection) => (
                    <TableRow key={connection.id}>
                      <TableCell>
                        <Link component={RouterLink} to={ssoConnectionRoute(connection.id)}>
                          {connection.name}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <Chip label={connection.protocol.toUpperCase()} size="small" />
                      </TableCell>
                      <TableCell>
                        <bdi dir="ltr">{connection.emailDomains.join(', ')}</bdi>
                      </TableCell>
                      <TableCell>
                        {new Intl.NumberFormat(latinNumbering(locale)).format(
                          connection.peopleCount,
                        )}
                      </TableCell>
                      <TableCell>
                        {connection.lastSignInAt
                          ? new Intl.DateTimeFormat(latinNumbering(locale), {
                              dateStyle: 'medium',
                            }).format(new Date(connection.lastSignInAt))
                          : t('sso:never')}
                      </TableCell>
                      <TableCell>
                        <Chip
                          label={t(connection.enabled ? 'sso:enabled' : 'sso:disabled')}
                          size="small"
                          color={connection.enabled ? 'success' : 'default'}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </SectionCard>
        <EnforcementCard
          key={JSON.stringify(settings.data)}
          settings={settings.data}
          targets={targets.data}
        />
      </Box>
      <Box component="aside" sx={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
        <SectionCard id="sso-sp" heading={t('sso:sp')} caption={t('sso:spHint')}>
          <SsoPublicValue
            id="sso-sp-entity"
            label={t('sso:entityId')}
            value={targets.data.sp.entityId}
          />
          <SsoPublicValue
            id="sso-sp-metadata"
            label={t('sso:metadataUrl')}
            value={targets.data.sp.metadataUrl}
          />
        </SectionCard>
        <SectionCard id="sso-sync" heading={t('sso:sync')} caption={t('sso:syncHint')}>
          <Typography variant="caption">{t('sso:breakGlassHint')}</Typography>
        </SectionCard>
      </Box>
    </Box>
  );
}

function EnforcementCard({ settings, targets }: { settings: SsoSettings; targets: SsoTargets }) {
  const t = useT();
  const api = useSsoApi();
  const toast = useToast();
  const client = useQueryClient();
  const [enforced, setEnforced] = useState(settings.enforced);
  const [admins, setAdmins] = useState(settings.breakGlassUserIds);
  const save = useMutation({
    mutationFn: () => api.saveSettings({ enforced, breakGlassUserIds: admins }),
    onSuccess: (updated) => {
      client.setQueryData(ssoKeys.settings, updated);
      void client.invalidateQueries({ queryKey: ['auth', 'methods'] });
      toast({ tone: 'success', message: t('sso:saved') });
    },
  });
  const discard = () => {
    setEnforced(settings.enforced);
    setAdmins(settings.breakGlassUserIds);
    save.reset();
  };
  return (
    <SectionCard
      id="sso-enforcement"
      heading={t('sso:enforcement')}
      caption={t('sso:enforcementHint')}
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
      footer={
        <>
          <Button onClick={discard} disabled={save.isPending}>
            {t('common:actions.discard')}
          </Button>
          <Button type="submit" variant="contained" loading={save.isPending}>
            {t('common:actions.save')}
          </Button>
        </>
      }
    >
      <FormControlLabel
        control={
          <Checkbox
            checked={enforced}
            disabled={settings.enforcedLocked}
            onChange={(event) => setEnforced(event.target.checked)}
          />
        }
        label={t('sso:require')}
      />
      <TextField
        select
        label={t('sso:breakGlass')}
        value={admins}
        disabled={settings.breakGlassLocked}
        helperText={t('sso:breakGlassHint')}
        slotProps={{ select: { multiple: true } }}
        onChange={(event) =>
          setAdmins(
            typeof event.target.value === 'string'
              ? event.target.value.split(',')
              : (event.target.value as string[]),
          )
        }
      >
        {targets.admins.map((admin) => (
          <MenuItem
            key={admin.id}
            value={admin.id}
            disabled={!admin.eligible || (admins.length >= 3 && !admins.includes(admin.id))}
          >
            {admin.name}
            {!admin.eligible ? ` · ${t('sso:ineligible')}` : ''}
          </MenuItem>
        ))}
      </TextField>
      {settings.enforcedLocked || settings.breakGlassLocked ? (
        <AlertBanner tone="info">
          {t('settings:lock.hint', {
            envKey: settings.enforcedLocked ? 'HD_SSO_ENFORCED' : 'HD_SSO_BREAK_GLASS_USER_IDS',
            envFile: '.env',
          })}
        </AlertBanner>
      ) : null}
      {save.isError ? <AlertBanner tone="danger">{t('sso:saveError')}</AlertBanner> : null}
    </SectionCard>
  );
}
