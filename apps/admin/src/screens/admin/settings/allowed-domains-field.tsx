import {
  GOOGLE_CONSUMER_DOMAINS,
  MAX_GOOGLE_ALLOWED_DOMAINS,
  workspaceDomainSchema,
} from '@helpdock/schemas';
import { Autocomplete, Chip, TextField } from '@mui/material';
import { type ReactNode, useState } from 'react';
import { useT } from '../../../app/i18n.js';
import { Field, fieldDescribedBy } from '../../../ui/field.tsx';

/**
 * Google's "Allowed Workspace domains" (`oauth.google.allowedDomains`,
 * `Admin/Settings-Authentication`, M18-07): the multi Combobox of DESIGN §6.1
 * with free entry, one chip per domain. A typed domain is added on Enter or
 * when the field loses focus, lower-cased and without a leading `@`; anything
 * that is not a domain stays in the input with the error under it. Pinned by
 * `HD_OAUTH_GOOGLE_ALLOWED_DOMAINS`, it is read-only and says so.
 */
export function AllowedDomainsField({
  id,
  domains,
  locked,
  lockHint,
  lockBadge,
  onChange,
}: {
  readonly id: string;
  readonly domains: readonly string[];
  readonly locked: boolean;
  readonly lockHint: string;
  readonly lockBadge: ReactNode;
  onChange(domains: string[]): void;
}): ReactNode {
  const t = useT();
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | undefined>();
  const hint = locked ? lockHint : t('settings:oauth.allowedDomainsHint');

  const add = (entries: readonly string[]): void => {
    const parsed = entries.map((entry) =>
      workspaceDomainSchema.safeParse(entry.trim().replace(/^@/, '')),
    );
    if (parsed.some((result) => !result.success)) {
      setError(t('settings:oauth.allowedDomainsInvalid'));
      return;
    }
    if (parsed.some((result) => GOOGLE_CONSUMER_DOMAINS.includes(result.data ?? ''))) {
      setError(t('settings:oauth.allowedDomainsConsumer'));
      return;
    }
    const next = [...new Set(parsed.flatMap((result) => (result.success ? [result.data] : [])))];
    if (next.length > MAX_GOOGLE_ALLOWED_DOMAINS) {
      setError(t('settings:oauth.allowedDomainsTooMany', { count: MAX_GOOGLE_ALLOWED_DOMAINS }));
      return;
    }
    setError(undefined);
    setInput('');
    onChange(next);
  };

  return (
    <Field
      id={id}
      label={t('settings:oauth.allowedDomains')}
      hint={hint}
      error={error}
      action={locked ? lockBadge : undefined}
    >
      <Autocomplete
        id={id}
        multiple
        freeSolo
        autoSelect
        disableClearable
        options={[]}
        value={[...domains]}
        inputValue={input}
        readOnly={locked}
        // The theme fixes inputs at 36 px; the chips wrap, so this one grows.
        sx={{ '& .MuiOutlinedInput-root': { height: 'auto', minHeight: 36, paddingBlock: '2px' } }}
        onInputChange={(_event, value, reason) => {
          // A chosen value clears the input by itself; keep what was typed when
          // the value was refused, so it can be corrected.
          if (reason !== 'reset') {
            setInput(value);
          }
        }}
        onChange={(_event, value) => {
          add(value);
        }}
        renderValue={(value, getItemProps) =>
          value.map((domain, index) => {
            const { key, ...chipProps } = getItemProps({ index });
            return (
              <Chip key={key} size="small" label={<bdi dir="ltr">{domain}</bdi>} {...chipProps} />
            );
          })
        }
        renderInput={(params) => (
          <TextField
            {...params}
            placeholder={locked ? undefined : t('settings:oauth.allowedDomainsPlaceholder')}
            error={error !== undefined}
            slotProps={{
              ...params.slotProps,
              htmlInput: {
                ...params.slotProps.htmlInput,
                dir: 'ltr',
                'aria-describedby': fieldDescribedBy(id, { hint, error }),
              },
            }}
          />
        )}
      />
    </Field>
  );
}
