import {
  type SsoConnectionDetail,
  type SsoConnectionInput,
  type SsoMapping,
  type SsoTargets,
  ssoConnectionCreateSchema,
  ssoMappingsSchema,
} from '@helpdock/schemas';
import {
  Box,
  Button,
  Checkbox,
  CircularProgress,
  FormControlLabel,
  Link,
  MenuItem,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link as RouterLink, useNavigate, useParams, useSearchParams } from 'react-router';
import { useT } from '../../../app/i18n.js';
import { ROUTES, ssoConnectionRoute } from '../../../app/route-paths.js';
import { PageHeader } from '../../../shell/page-header.js';
import { isSsoError, ssoKeys } from '../../../sso/api.js';
import { useSsoApi } from '../../../sso/context.tsx';
import { AlertBanner } from '../../../ui/alert-banner.tsx';
import { ConfirmDialog } from '../../../ui/confirm-dialog.tsx';
import { useToast } from '../../../ui/toasts.tsx';
import { SectionCard } from '../channels/section-card.tsx';
import { SSO_ROLE_LABELS, SsoAccessControls } from './sso-access-controls.tsx';
import { type SsoMappingDraft, SsoMappings } from './sso-mappings.tsx';
import { SsoPresetPicker } from './sso-preset-picker.tsx';
import { hasIssuerPlaceholder, type SsoPresetId } from './sso-presets.ts';
import { OidcFields, SamlFields } from './sso-protocol-fields.tsx';
import { SsoPublicValue } from './sso-public-value.tsx';

const emptyConnection = (): SsoConnectionInput => ({
  name: '',
  enabled: false,
  emailDomains: [],
  jitEnabled: true,
  idpEnforcesMfa: false,
  defaultAccess: null,
  groupAttribute: null,
  config: {
    protocol: 'oidc',
    issuer: '',
    clientId: '',
    scopes: ['openid', 'email', 'profile'],
    emailClaim: 'email',
    nameClaim: 'name',
    requireEmailVerified: true,
  },
});

/** Admin/Settings-SSO-Connection. Protocol secrets stay in local form state until saved. */
export function SsoConnectionPage() {
  const t = useT();
  const api = useSsoApi();
  const { id = 'new' } = useParams<{ id: string }>();
  const connection = useQuery({
    queryKey: ssoKeys.connection(id),
    queryFn: () => api.connection(id),
    enabled: id !== 'new',
  });
  const mappings = useQuery({
    queryKey: ssoKeys.mappings(id),
    queryFn: () => api.mappings(id),
    enabled: id !== 'new',
  });
  const targets = useQuery({ queryKey: ssoKeys.targets, queryFn: () => api.targets() });
  if (targets.isPending || (id !== 'new' && (connection.isPending || mappings.isPending)))
    return (
      <Box role="status">
        <CircularProgress size={20} aria-hidden="true" />
        {t('common:loading')}
      </Box>
    );
  if (!targets.data || (id !== 'new' && (!connection.data || !mappings.data)))
    return <AlertBanner tone="danger">{t('sso:error')}</AlertBanner>;
  return (
    <ConnectionForm
      key={`${id}:${connection.data?.updatedAt ?? ''}`}
      id={id}
      connection={connection.data}
      mappings={mappings.data?.mappings ?? []}
      targets={targets.data}
    />
  );
}

function ConnectionForm({
  id,
  connection,
  mappings: originalMappings,
  targets,
}: {
  id: string;
  connection: SsoConnectionDetail | undefined;
  mappings: SsoMapping[];
  targets: SsoTargets;
}) {
  const t = useT();
  const api = useSsoApi();
  const toast = useToast();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [search] = useSearchParams();
  const [draft, setDraft] = useState<SsoConnectionInput>(() =>
    connection ? ssoConnectionCreateSchema.parse(connection) : emptyConnection(),
  );
  const [mappings, setMappings] = useState<SsoMappingDraft[]>(() =>
    originalMappings.map((mapping) => ({ ...mapping, rowKey: crypto.randomUUID() })),
  );
  const [secret, setSecret] = useState<string | null>(connection?.secretConfigured ? null : '');
  const [domains, setDomains] = useState(draft.emailDomains.join(', '));
  const [invalid, setInvalid] = useState(false);
  const [preset, setPreset] = useState<SsoPresetId>('custom');
  const [deleting, setDeleting] = useState(false);
  const [popupBlocked, setPopupBlocked] = useState(false);
  const initial = connection ? ssoConnectionCreateSchema.parse(connection) : emptyConnection();
  const dirty =
    JSON.stringify(draft) !== JSON.stringify(initial) ||
    domains !== initial.emailDomains.join(', ') ||
    Boolean(secret) ||
    JSON.stringify(mappings.map(({ rowKey: _key, ...mapping }) => mapping)) !==
      JSON.stringify(originalMappings);
  const testKey = search.get('test') ?? '';
  const preview = useQuery({
    queryKey: ssoKeys.test(id, testKey),
    queryFn: () => api.testResult(id, testKey),
    enabled: id !== 'new' && testKey.length > 0,
    retry: false,
    staleTime: Infinity,
  });
  const save = useMutation({
    onError: (error) => {
      // The api will not send the stored client secret to an issuer it was not saved for.
      if (isSsoError(error) && error.reason === 'sso-client-secret-required')
        setSecret((held) => held ?? '');
    },
    mutationFn: async (input: SsoConnectionInput) => {
      const updated = await api.saveConfiguration(id === 'new' ? null : id, {
        connection: input,
        mappings,
      });
      setSecret(updated.secretConfigured ? null : '');
      return updated;
    },
    onSuccess: async (updated) => {
      await client.invalidateQueries({ queryKey: ['sso'] });
      await client.invalidateQueries({ queryKey: ['auth', 'methods'] });
      toast({ tone: 'success', message: t('sso:saved') });
      void navigate(ssoConnectionRoute(updated.id), { replace: true });
    },
  });
  const remove = useMutation({
    mutationFn: () => api.remove(id),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ssoKeys.connections });
      void navigate(ROUTES.sso);
    },
  });
  const test = useMutation({ mutationFn: () => api.test(id) });
  const refusal = isSsoError(save.error) ? save.error : null;
  const secretRefused = refusal?.reason === 'sso-client-secret-required';
  const domainsTaken = refusal?.reason === 'sso-email-domain-taken' ? refusal.domains : null;
  const submit = () => {
    const parsed = ssoConnectionCreateSchema.safeParse({
      ...draft,
      emailDomains: domains
        .split(',')
        .map((domain) => domain.trim())
        .filter(Boolean),
      ...(secret ? { clientSecret: secret } : {}),
    });
    const parsedMappings = ssoMappingsSchema.safeParse({ mappings });
    const valid = parsed.success && parsedMappings.success && !hasIssuerPlaceholder(draft);
    setInvalid(!valid);
    if (valid) save.mutate(parsed.data);
  };
  const startTest = () => {
    const popup = window.open('about:blank', '_blank');
    setPopupBlocked(!popup);
    if (!popup) return;
    popup.opener = null;
    test.mutate(undefined, {
      onSuccess: ({ startUrl }) => {
        if (popup) popup.location.href = startUrl;
      },
      onError: () => popup?.close(),
    });
  };
  const setConfig = (config: SsoConnectionInput['config']) => setDraft({ ...draft, config });
  const protocol = draft.config.protocol;
  const linked = (connection?.peopleCount ?? 0) > 0;
  const presetHint = (field: 'issuerHint' | 'groupsHint' | 'domainsHint') =>
    preset === 'custom' ? undefined : t(`sso:presets.${preset}.${field}`);
  const input = (
    label: string,
    value: string,
    onChange: (value: string) => void,
    options: { multiline?: boolean; disabled?: boolean; helperText?: string | undefined } = {},
  ) => (
    <TextField
      label={label}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      fullWidth
      multiline={options.multiline ?? false}
      disabled={options.disabled ?? false}
      helperText={options.helperText}
      slotProps={{ htmlInput: { dir: 'ltr' } }}
    />
  );
  return (
    <>
      <Link component={RouterLink} to={ROUTES.sso}>
        {t('sso:title')}
      </Link>
      <PageHeader title={connection?.name ?? t('sso:add')} caption={t('sso:providerHint')} />
      {invalid ? <AlertBanner tone="danger">{t('sso:invalid')}</AlertBanner> : null}
      {(save.isError && !secretRefused) || remove.isError ? (
        <AlertBanner tone="danger">
          {refusal?.reason === 'sso-metadata-confirm-certificates'
            ? t('sso:refusals.sso-metadata-confirm-certificates')
            : t('sso:saveError')}
        </AlertBanner>
      ) : null}
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: 'minmax(0, 1fr)', xl: 'minmax(0, 1fr) 360px' },
          gap: 8,
          alignItems: 'start',
        }}
      >
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
          <SectionCard
            id="sso-provider"
            heading={t('sso:provider')}
            caption={t('sso:providerHint')}
            aside={
              <FormControlLabel
                control={
                  <Checkbox
                    checked={draft.enabled}
                    onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
                  />
                }
                label={t('sso:enabled')}
              />
            }
          >
            <ToggleButtonGroup
              value={protocol}
              exclusive
              disabled={id !== 'new'}
              aria-label={t('sso:protocol')}
              onChange={(_event, selected: 'oidc' | 'saml' | null) => {
                if (!selected || selected === protocol) return;
                setPreset('custom');
                setConfig(
                  selected === 'oidc'
                    ? emptyConnection().config
                    : {
                        protocol: 'saml',
                        idpEntityId: '',
                        idpSsoUrl: '',
                        idpCertificates: [],
                        nameIdFormat: 'persistent',
                        signAuthnRequests: true,
                        allowIdpInitiated: false,
                        clockSkewSeconds: 60,
                      },
                );
              }}
            >
              <ToggleButton value="oidc">OpenID Connect</ToggleButton>
              <ToggleButton value="saml">SAML 2.0</ToggleButton>
            </ToggleButtonGroup>
            <TextField
              label={t('sso:label')}
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              slotProps={{ htmlInput: { maxLength: 80 } }}
            />
            {draft.config.protocol === 'oidc' && id === 'new' ? (
              <SsoPresetPicker
                draft={draft}
                preset={preset}
                onChange={(next, applied) => {
                  setPreset(next);
                  setDraft(applied);
                }}
              />
            ) : null}
            {draft.config.protocol === 'oidc' ? (
              <OidcFields
                config={draft.config}
                onChange={setConfig}
                linked={linked}
                secret={secret}
                secretConfigured={connection?.secretConfigured ?? false}
                secretError={
                  secretRefused ? t('sso:refusals.sso-client-secret-required') : undefined
                }
                onSecretChange={(next) => {
                  setSecret(next);
                  if (secretRefused) save.reset();
                }}
                issuerHint={presetHint('issuerHint')}
                issuerInvalid={invalid && hasIssuerPlaceholder(draft)}
              />
            ) : (
              <SamlFields config={draft.config} onChange={setConfig} linked={linked} />
            )}
            {input(
              t('sso:groups'),
              draft.groupAttribute ?? '',
              (groupAttribute) => setDraft({ ...draft, groupAttribute: groupAttribute || null }),
              { helperText: presetHint('groupsHint') },
            )}
          </SectionCard>
          <SectionCard id="sso-access" heading={t('sso:access')} caption={t('sso:domainsHint')}>
            <TextField
              label={t('sso:domains')}
              value={domains}
              onChange={(event) => {
                setDomains(event.target.value);
                if (domainsTaken) save.reset();
              }}
              error={domainsTaken !== null}
              helperText={
                domainsTaken
                  ? t('sso:refusals.sso-email-domain-taken', { domains: domainsTaken.join(', ') })
                  : presetHint('domainsHint')
              }
              slotProps={{ htmlInput: { dir: 'ltr' } }}
            />
            <FormControlLabel
              control={
                <Checkbox
                  checked={draft.jitEnabled}
                  onChange={(event) => setDraft({ ...draft, jitEnabled: event.target.checked })}
                />
              }
              label={t('sso:jit')}
            />
            <FormControlLabel
              control={
                <Checkbox
                  checked={draft.idpEnforcesMfa}
                  onChange={(event) => setDraft({ ...draft, idpEnforcesMfa: event.target.checked })}
                />
              }
              label={t('sso:mfa')}
            />
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              {t('sso:mfaHint')}
            </Typography>
            <TextField
              select
              label={t('sso:unmapped')}
              value={draft.defaultAccess ? 'default' : 'deny'}
              onChange={(event) => {
                const first = targets.brands[0];
                setDraft({
                  ...draft,
                  defaultAccess:
                    event.target.value === 'default' && first
                      ? { brandId: first.id, role: 'viewer', departmentIds: null }
                      : null,
                });
              }}
            >
              <MenuItem value="deny">{t('sso:deny')}</MenuItem>
              <MenuItem value="default" disabled={targets.brands.length === 0}>
                {t('sso:defaultAccess')}
              </MenuItem>
            </TextField>
            {draft.defaultAccess ? (
              <SsoAccessControls
                access={draft.defaultAccess}
                targets={targets}
                onChange={(defaultAccess) => setDraft({ ...draft, defaultAccess })}
              />
            ) : null}
          </SectionCard>
          <SsoMappings mappings={mappings} targets={targets} onChange={setMappings} />
          <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 3 }}>
            <Button
              onClick={() => {
                void navigate(ROUTES.sso);
              }}
            >
              {t('common:actions.discard')}
            </Button>
            <Button variant="contained" loading={save.isPending} onClick={submit}>
              {t('sso:saveConnection')}
            </Button>
          </Box>
        </Box>
        <Box
          component="aside"
          sx={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}
        >
          <SectionCard id="sso-values" heading={t('sso:sp')} caption={t('sso:spHint')}>
            {connection ? (
              <>
                <SsoPublicValue
                  id="sso-redirect"
                  label={t('sso:redirectUri')}
                  value={connection.sp.oidcRedirectUri}
                />
                <SsoPublicValue id="sso-acs" label={t('sso:acsUrl')} value={connection.sp.acsUrl} />
              </>
            ) : null}
            <SsoPublicValue id="sso-entity" label={t('sso:entityId')} value={targets.sp.entityId} />
            <SsoPublicValue
              id="sso-metadata"
              label={t('sso:metadataUrl')}
              value={targets.sp.metadataUrl}
            />
          </SectionCard>
          <SectionCard id="sso-test" heading={t('sso:test')} caption={t('sso:testHint')}>
            <Button
              variant="outlined"
              startIcon={<ExternalLink size={16} aria-hidden="true" />}
              disabled={!connection?.enabled || save.isPending || dirty}
              loading={test.isPending}
              onClick={startTest}
            >
              {t('sso:test')}
            </Button>
            {!connection?.enabled || dirty ? (
              <Typography variant="caption">{t('sso:testEnabled')}</Typography>
            ) : null}
            {popupBlocked ? (
              <AlertBanner tone="warning">{t('sso:popupBlocked')}</AlertBanner>
            ) : null}
            {test.isError || preview.isError ? (
              <AlertBanner tone="danger">{t('sso:error')}</AlertBanner>
            ) : null}
            {preview.data ? (
              <>
                <AlertBanner tone={preview.data.conflict ? 'warning' : 'success'}>
                  {t(preview.data.conflict ? 'sso:conflict' : 'sso:testPassed')}
                </AlertBanner>
                <Typography variant="caption">
                  <bdi dir="ltr">{preview.data.claims.subject}</bdi>
                  <br />
                  <bdi dir="ltr">{preview.data.claims.email}</bdi>
                  <br />
                  <bdi dir="ltr">{preview.data.claims.groups.join(', ')}</bdi>
                </Typography>
                <Typography variant="bodyStrong">
                  {preview.data.user?.name ??
                    t(preview.data.wouldCreate ? 'sso:wouldCreate' : 'sso:wouldRefuse')}
                </Typography>
                {preview.data.access.map((access) => (
                  <Typography key={access.brandId} variant="caption">
                    {targets.brands.find((brand) => brand.id === access.brandId)?.name} ·{' '}
                    {t(SSO_ROLE_LABELS[access.role])}
                  </Typography>
                ))}
              </>
            ) : null}
          </SectionCard>
          {id !== 'new' ? (
            <SectionCard id="sso-delete" heading={t('sso:delete')} caption={t('sso:deleteHint')}>
              <Button
                variant="outlined"
                color="error"
                startIcon={<Trash2 size={16} aria-hidden="true" />}
                disabled={linked}
                onClick={() => setDeleting(true)}
              >
                {t('sso:delete')}
              </Button>
            </SectionCard>
          ) : null}
        </Box>
      </Box>
      <ConfirmDialog
        open={deleting}
        title={t('sso:deleteConfirm')}
        body={t('sso:deleteHint')}
        confirmLabel={t('sso:delete')}
        destructive
        busy={remove.isPending}
        onConfirm={() => remove.mutate()}
        onClose={() => setDeleting(false)}
      />
    </>
  );
}
