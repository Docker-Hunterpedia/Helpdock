import {
  type ImportRunView,
  importConnectionRequestSchema,
  importFileSourceRequestSchema,
  type ZohoCredentials,
} from '@helpdock/schemas';
import {
  Box,
  Button,
  FormControlLabel,
  MenuItem,
  Radio,
  RadioGroup,
  TextField,
} from '@mui/material';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useT } from '../../../app/i18n.js';
import { useImportsApi } from '../../../imports/context.tsx';
import { AlertBanner } from '../../../ui/alert-banner.tsx';
import { Field } from '../../../ui/field.tsx';
import { SectionCard } from '../channels/section-card.tsx';
import { ZohoConnectionFields } from './zoho-connection-fields.js';

export function ImportConnection({
  run,
  onConnected,
}: {
  run: ImportRunView;
  onConnected: (run: ImportRunView) => void;
}) {
  const t = useT();
  const api = useImportsApi();
  const [auth, setAuth] = useState<'api_token' | 'oauth'>('api_token');
  const [subdomain, setSubdomain] = useState('');
  const [email, setEmail] = useState('');
  const [secret, setSecret] = useState('');
  const [dataset, setDataset] = useState('');
  const [hosts, setHosts] = useState('');
  const [csatApi, setCsatApi] = useState<'legacy' | 'modern'>('modern');
  const [invalid, setInvalid] = useState(false);
  const [zoho, setZoho] = useState<ZohoCredentials>({
    region: 'us',
    orgId: '',
    clientId: '',
    clientSecret: '',
    refreshToken: '',
  });
  const connect = useMutation({
    gcTime: 0,
    mutationFn: async () => {
      const downloadHosts = hosts.split(/[\s,]+/u).filter(Boolean);
      if (run.source === 'file') {
        const input = importFileSourceRequestSchema.safeParse({ dataset, downloadHosts });
        if (!input.success) {
          setInvalid(true);
          return null;
        }
        return api.connectFiles(run.brandId, run.id, input.data);
      }
      const credentials =
        run.source === 'zohodesk'
          ? zoho
          : run.source === 'freshdesk'
            ? { domain: subdomain, apiKey: secret, csatApi }
            : auth === 'api_token'
              ? { auth, subdomain, email, apiToken: secret }
              : { auth, subdomain, accessToken: secret };
      const input = importConnectionRequestSchema.safeParse({ credentials, downloadHosts });
      if (!input.success) {
        setInvalid(true);
        return null;
      }
      return (await api.connect(run.brandId, run.id, input.data)).run;
    },
    onSuccess: (connected) => {
      if (connected) {
        setSecret('');
        setZoho((previous) => ({ ...previous, clientSecret: '', refreshToken: '' }));
        onConnected(connected);
      }
    },
  });
  if (!['file', 'zendesk', 'freshdesk', 'zohodesk'].includes(run.source))
    return <AlertBanner tone="warning">{t('imports:new.unavailable')}</AlertBanner>;
  return (
    <SectionCard
      id="import-connect"
      heading={t('imports:connection.title')}
      caption={t(
        run.source === 'file'
          ? 'imports:connection.fileCaption'
          : run.source === 'zohodesk'
            ? 'imports:connection.zoho.caption'
            : run.source === 'freshdesk'
              ? 'imports:connection.freshdeskCaption'
              : 'imports:connection.caption',
      )}
      onSubmit={(event) => {
        event.preventDefault();
        setInvalid(false);
        connect.mutate();
      }}
      footer={
        <Button type="submit" variant="contained" disabled={connect.isPending}>
          {t('imports:connection.test')}
        </Button>
      }
    >
      {invalid ? <AlertBanner tone="danger">{t('imports:connection.invalid')}</AlertBanner> : null}
      {connect.isError ? (
        <AlertBanner tone="danger">{t('imports:connection.failed')}</AlertBanner>
      ) : null}
      {run.source === 'file' ? (
        <Field
          id="import-dataset"
          label={t('imports:connection.dataset')}
          hint={t('imports:connection.datasetHint')}
        >
          <TextField
            id="import-dataset"
            value={dataset}
            onChange={(event) => setDataset(event.target.value)}
            disabled={connect.isPending}
            slotProps={{ htmlInput: { dir: 'ltr', 'aria-describedby': 'import-dataset-hint' } }}
          />
        </Field>
      ) : run.source === 'zohodesk' ? (
        <ZohoConnectionFields credentials={zoho} onChange={setZoho} disabled={connect.isPending} />
      ) : (
        <>
          <Field
            id="import-subdomain"
            label={t(
              run.source === 'freshdesk'
                ? 'imports:connection.freshdeskDomain'
                : 'imports:connection.subdomain',
            )}
            hint={
              run.source === 'freshdesk' ? t('imports:connection.freshdeskDomainHint') : undefined
            }
          >
            <TextField
              id="import-subdomain"
              value={subdomain}
              onChange={(event) => setSubdomain(event.target.value)}
              disabled={connect.isPending}
              slotProps={{
                htmlInput: {
                  dir: 'ltr',
                  autoComplete: 'off',
                  ...(run.source === 'freshdesk'
                    ? { 'aria-describedby': 'import-subdomain-hint' }
                    : {}),
                },
              }}
            />
          </Field>
          {run.source === 'zendesk' ? (
            <RadioGroup
              value={auth}
              aria-label={t('imports:connection.auth')}
              onChange={(_, value) => {
                setAuth(value === 'oauth' ? 'oauth' : 'api_token');
                setSecret('');
              }}
            >
              <FormControlLabel
                value="api_token"
                control={<Radio disabled={connect.isPending} />}
                label={t('imports:connection.apiToken')}
              />
              <FormControlLabel
                value="oauth"
                control={<Radio disabled={connect.isPending} />}
                label={t('imports:connection.oauthToken')}
              />
            </RadioGroup>
          ) : null}
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'repeat(2, minmax(0, 1fr))' },
              gap: 4,
            }}
          >
            {run.source === 'zendesk' && auth === 'api_token' ? (
              <Field id="import-email" label={t('imports:connection.email')}>
                <TextField
                  id="import-email"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  disabled={connect.isPending}
                  slotProps={{ htmlInput: { dir: 'ltr', autoComplete: 'off' } }}
                />
              </Field>
            ) : null}
            <Field
              id="import-secret"
              label={t(
                run.source === 'freshdesk'
                  ? 'imports:connection.freshdeskKey'
                  : auth === 'api_token'
                    ? 'imports:connection.apiToken'
                    : 'imports:connection.oauthToken',
              )}
              hint={t('imports:connection.secretHint')}
            >
              <TextField
                id="import-secret"
                type="password"
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
                disabled={connect.isPending}
                slotProps={{
                  htmlInput: {
                    dir: 'ltr',
                    autoComplete: 'new-password',
                    'aria-describedby': 'import-secret-hint',
                  },
                }}
              />
            </Field>
          </Box>
          {run.source === 'freshdesk' ? (
            <Field
              id="import-csat-api"
              label={t('imports:connection.csatApi')}
              hint={t('imports:connection.csatApiHint')}
            >
              <TextField
                id="import-csat-api"
                select
                size="small"
                value={csatApi}
                disabled={connect.isPending}
                slotProps={{
                  select: {
                    inputProps: {
                      'aria-label': t('imports:connection.csatApi'),
                      'aria-describedby': 'import-csat-api-hint',
                    },
                  },
                }}
                onChange={(event) =>
                  setCsatApi(event.target.value === 'legacy' ? 'legacy' : 'modern')
                }
              >
                <MenuItem value="modern">{t('imports:connection.csatModern')}</MenuItem>
                <MenuItem value="legacy">{t('imports:connection.csatLegacy')}</MenuItem>
              </TextField>
            </Field>
          ) : null}
        </>
      )}
      <Field
        id="import-download-hosts"
        label={t('imports:connection.downloadHosts')}
        hint={t('imports:connection.hostsHint')}
      >
        <TextField
          id="import-download-hosts"
          value={hosts}
          onChange={(event) => setHosts(event.target.value)}
          disabled={connect.isPending}
          slotProps={{
            htmlInput: { dir: 'ltr', 'aria-describedby': 'import-download-hosts-hint' },
          }}
        />
      </Field>
    </SectionCard>
  );
}
