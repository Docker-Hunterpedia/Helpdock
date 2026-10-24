import type { SsoConnectionInput } from '@helpdock/schemas';
import { Box, Checkbox, FormControlLabel, MenuItem, TextField } from '@mui/material';
import { useState } from 'react';
import { useT } from '../../../app/i18n.js';
import { SecretField } from '../../../ui/secret-field.tsx';
import { SsoCertificates } from './sso-certificates.tsx';

type OidcConfig = Extract<SsoConnectionInput['config'], { protocol: 'oidc' }>;
export function OidcFields({
  config,
  onChange,
  linked,
  secret,
  secretConfigured,
  secretError,
  onSecretChange,
  issuerHint,
  issuerInvalid = false,
}: {
  config: OidcConfig;
  onChange: (config: OidcConfig) => void;
  linked: boolean;
  secret: string | null;
  secretConfigured: boolean;
  /** The api asked for the secret again because the issuer changed. */
  secretError?: string | undefined;
  onSecretChange: (secret: string | null) => void;
  /** A preset's note under the issuer, such as the Entra tenant template (M18-09). */
  issuerHint?: string | undefined;
  issuerInvalid?: boolean;
}) {
  const t = useT();
  const [scopes, setScopes] = useState(config.scopes.join(' '));
  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: { xs: 'minmax(0,1fr)', md: 'repeat(2,minmax(0,1fr))' },
        gap: 4,
      }}
    >
      <TextField
        label={t('sso:issuer')}
        value={config.issuer}
        disabled={linked}
        error={issuerInvalid}
        helperText={issuerHint}
        onChange={(event) => onChange({ ...config, issuer: event.target.value })}
        slotProps={{ htmlInput: { dir: 'ltr' } }}
      />
      <TextField
        label={t('sso:clientId')}
        value={config.clientId}
        disabled={linked}
        onChange={(event) => onChange({ ...config, clientId: event.target.value })}
        slotProps={{ htmlInput: { dir: 'ltr' } }}
      />
      <SecretField
        id="sso-client-secret"
        label={t('sso:clientSecret')}
        stored={secretConfigured}
        value={secret}
        error={secretError}
        replaceLabel={t('settings:oauth.replaceLabel', { provider: 'OIDC' })}
        onChange={onSecretChange}
      />
      <TextField
        label={t('sso:scopes')}
        value={scopes}
        onChange={(event) => {
          setScopes(event.target.value);
          onChange({ ...config, scopes: event.target.value.split(/\s+/).filter(Boolean) });
        }}
        slotProps={{ htmlInput: { dir: 'ltr' } }}
      />
      <TextField
        label={t('sso:emailAttribute')}
        slotProps={{ htmlInput: { dir: 'ltr' } }}
        value={config.emailClaim}
        onChange={(event) => onChange({ ...config, emailClaim: event.target.value })}
      />
      <TextField
        label={t('sso:nameAttribute')}
        slotProps={{ htmlInput: { dir: 'ltr' } }}
        value={config.nameClaim}
        onChange={(event) => onChange({ ...config, nameClaim: event.target.value })}
      />
    </Box>
  );
}

type SamlConfig = Extract<SsoConnectionInput['config'], { protocol: 'saml' }>;
export function SamlFields({
  config,
  onChange,
  linked,
}: {
  config: SamlConfig;
  onChange: (config: SamlConfig) => void;
  linked: boolean;
}) {
  const t = useT();
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <TextField
        label={t('sso:idpMetadataUrl')}
        slotProps={{ htmlInput: { dir: 'ltr' } }}
        value={config.idpMetadataUrl ?? ''}
        onChange={(event) => {
          const { idpMetadataUrl: _old, ...remaining } = config;
          onChange(
            event.target.value ? { ...remaining, idpMetadataUrl: event.target.value } : remaining,
          );
        }}
      />
      <TextField
        label={t('sso:idpEntityId')}
        slotProps={{ htmlInput: { dir: 'ltr' } }}
        value={config.idpEntityId}
        disabled={linked}
        onChange={(event) => onChange({ ...config, idpEntityId: event.target.value })}
      />
      <TextField
        label={t('sso:idpSsoUrl')}
        slotProps={{ htmlInput: { dir: 'ltr' } }}
        value={config.idpSsoUrl}
        onChange={(event) => onChange({ ...config, idpSsoUrl: event.target.value })}
      />
      <TextField
        select
        label={t('sso:nameIdFormat')}
        value={config.nameIdFormat}
        disabled={linked}
        onChange={(event) =>
          onChange({ ...config, nameIdFormat: event.target.value as SamlConfig['nameIdFormat'] })
        }
      >
        {['persistent', 'emailAddress', 'unspecified'].map((format) => (
          <MenuItem key={format} value={format}>
            {t(`sso:nameId.${format as SamlConfig['nameIdFormat']}`)}
          </MenuItem>
        ))}
      </TextField>
      <TextField
        label={t('sso:emailAttribute')}
        slotProps={{ htmlInput: { dir: 'ltr' } }}
        value={config.emailAttribute ?? ''}
        onChange={(event) => {
          const { emailAttribute: _old, ...remaining } = config;
          onChange(
            event.target.value ? { ...remaining, emailAttribute: event.target.value } : remaining,
          );
        }}
      />
      <TextField
        label={t('sso:nameAttribute')}
        slotProps={{ htmlInput: { dir: 'ltr' } }}
        value={config.nameAttribute ?? ''}
        onChange={(event) => {
          const { nameAttribute: _old, ...remaining } = config;
          onChange(
            event.target.value ? { ...remaining, nameAttribute: event.target.value } : remaining,
          );
        }}
      />
      <SsoCertificates
        certificates={config.idpCertificates}
        onChange={(idpCertificates) => onChange({ ...config, idpCertificates })}
      />
      <FormControlLabel
        control={
          <Checkbox
            checked={config.allowIdpInitiated}
            onChange={(event) => onChange({ ...config, allowIdpInitiated: event.target.checked })}
          />
        }
        label={t('sso:allowIdpInitiated')}
      />
    </Box>
  );
}
