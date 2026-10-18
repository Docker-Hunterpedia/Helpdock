import { type ZohoCredentials, zohoCredentialsSchema } from '@helpdock/schemas';
import { MenuItem, TextField } from '@mui/material';
import { useT } from '../../../app/i18n.js';
import { Field } from '../../../ui/field.tsx';

const credentialFields = ['orgId', 'clientId', 'clientSecret', 'refreshToken'] as const;

export function ZohoConnectionFields({
  credentials,
  onChange,
  disabled,
}: {
  credentials: ZohoCredentials;
  onChange: (credentials: ZohoCredentials) => void;
  disabled: boolean;
}) {
  const t = useT();
  return (
    <>
      <Field id="import-zoho-region" label={t('imports:connection.zoho.region')}>
        <TextField
          id="import-zoho-region"
          select
          value={credentials.region}
          disabled={disabled}
          slotProps={{
            select: { inputProps: { 'aria-label': t('imports:connection.zoho.region') } },
          }}
          onChange={(event) => {
            const region = zohoCredentialsSchema.shape.region.parse(event.target.value);
            onChange({ ...credentials, region });
          }}
        >
          {zohoCredentialsSchema.shape.region.options.map((region) => (
            <MenuItem key={region} value={region}>
              {t(`imports:connection.zoho.regions.${region}`)}
            </MenuItem>
          ))}
        </TextField>
      </Field>
      {credentialFields.map((name) => {
        const secret = name === 'clientSecret' || name === 'refreshToken';
        const id = `import-zoho-${name}`;
        return (
          <Field
            key={name}
            id={id}
            label={t(`imports:connection.zoho.${name}`)}
            hint={secret ? t('imports:connection.secretHint') : undefined}
          >
            <TextField
              id={id}
              type={secret ? 'password' : 'text'}
              value={credentials[name]}
              disabled={disabled}
              onChange={(event) => onChange({ ...credentials, [name]: event.target.value })}
              slotProps={{
                htmlInput: {
                  dir: 'ltr',
                  autoComplete: secret ? 'new-password' : 'off',
                  ...(secret ? { 'aria-describedby': `${id}-hint` } : {}),
                },
              }}
            />
          </Field>
        );
      })}
    </>
  );
}
