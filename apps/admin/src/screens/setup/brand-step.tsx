import type { Locale } from '@helpdock/i18n';
import { SUPPORTED_LNGS } from '@helpdock/i18n';
import type { SetupBrandRequest } from '@helpdock/schemas';
import {
  isSupportedTimeZone,
  TICKET_PREFIX,
  TICKET_PREFIX_MAX_LENGTH,
  ticketNumberPreview,
} from '@helpdock/schemas';
import { Button, OutlinedInput, Select } from '@mui/material';
import { type ReactNode, useMemo, useState } from 'react';
import { useT } from '../../app/i18n.js';
import { Field, fieldDescribedBy } from '../../ui/field.tsx';
import { StepFrame } from './setup-layout.tsx';
import { currentTimeZone, timeZoneOptions } from './timezones.js';

/**
 * Step 2 of the artboard `Admin/Wizard`: the first brand.
 *
 * The prefix field previews the ticket number live, because it is the one
 * decision on this screen that cannot be undone: every ticket number, subject
 * line and email reference carries it for the life of the brand.
 */

const DOMAIN = /^(?!-)[a-z0-9-]{1,63}(?<!-)(?:\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

export interface BrandStepErrors {
  name?: 'required';
  prefix?: 'required' | 'invalid';
  timezone?: 'invalid';
  helpcenterDomain?: 'invalid';
}

export interface BrandDraft {
  readonly name: string;
  readonly prefix: string;
  readonly timezone: string;
  readonly helpcenterDomain: string;
}

export function validateBrand({
  name,
  prefix,
  timezone,
  helpcenterDomain,
}: BrandDraft): BrandStepErrors {
  const errors: BrandStepErrors = {};

  if (name.trim() === '') {
    errors.name = 'required';
  }

  if (prefix.trim() === '') {
    errors.prefix = 'required';
  } else if (!TICKET_PREFIX.test(prefix.trim())) {
    errors.prefix = 'invalid';
  }

  if (!isSupportedTimeZone(timezone)) {
    errors.timezone = 'invalid';
  }

  const domain = helpcenterDomain.trim().toLowerCase();
  if (domain !== '' && !DOMAIN.test(domain)) {
    errors.helpcenterDomain = 'invalid';
  }

  return errors;
}

export interface BrandStepProps {
  readonly onSubmit: (request: SetupBrandRequest) => void;
  readonly onBack: () => void;
  readonly pending: boolean;
  /** Set when the api refused the prefix as taken, which only it can know. */
  readonly prefixTaken: boolean;
}

export function BrandStep({ onSubmit, onBack, pending, prefixTaken }: BrandStepProps): ReactNode {
  const t = useT();
  const zones = useMemo(() => timeZoneOptions(), []);
  const [name, setName] = useState('');
  const [prefix, setPrefix] = useState('');
  const [defaultLocale, setDefaultLocale] = useState<Locale>('en');
  const [timezone, setTimezone] = useState(currentTimeZone);
  const [helpcenterDomain, setHelpcenterDomain] = useState('');
  const [errors, setErrors] = useState<BrandStepErrors>({});

  const submit = (): void => {
    const found = validateBrand({ name, prefix, timezone, helpcenterDomain });
    setErrors(found);

    if (Object.keys(found).length > 0) {
      return;
    }

    const domain = helpcenterDomain.trim().toLowerCase();
    onSubmit({
      name: name.trim(),
      prefix: prefix.trim(),
      defaultLocale,
      timezone,
      ...(domain === '' ? {} : { helpcenterDomain: domain }),
    });
  };

  const nameError = errors.name ? t('wizard:brand.nameRequired') : undefined;
  const prefixError = prefixTaken
    ? t('wizard:brand.prefixTaken')
    : errors.prefix === 'required'
      ? t('wizard:brand.prefixRequired')
      : errors.prefix === 'invalid'
        ? t('wizard:brand.prefixInvalid')
        : undefined;
  const timezoneError = errors.timezone ? t('wizard:brand.timezoneInvalid') : undefined;
  const domainError = errors.helpcenterDomain ? t('wizard:brand.domainInvalid') : undefined;
  const prefixHint = t('wizard:brand.prefixHint', { example: ticketNumberPreview(prefix) });
  const domainHint = t('wizard:brand.domainOptional');

  return (
    <StepFrame
      title={t('wizard:brand.title')}
      description={t('wizard:brand.description')}
      onSubmit={submit}
      footer={
        <>
          <Button type="button" variant="text" color="secondary" onClick={onBack}>
            {t('wizard:back')}
          </Button>
          <Button type="submit" variant="contained" color="primary" loading={pending}>
            {t('wizard:brand.submit')}
          </Button>
        </>
      }
    >
      <Field id="setup-brand-name" label={t('wizard:brand.nameLabel')} error={nameError}>
        <OutlinedInput
          id="setup-brand-name"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
          error={Boolean(nameError)}
          fullWidth
          slotProps={{
            input: {
              'aria-describedby': fieldDescribedBy('setup-brand-name', { error: nameError }),
            },
          }}
        />
      </Field>

      <Field
        id="setup-brand-prefix"
        label={t('wizard:brand.prefixLabel')}
        hint={prefixHint}
        error={prefixError}
      >
        <OutlinedInput
          id="setup-brand-prefix"
          value={prefix}
          onChange={(event) => {
            // Upper-cased as it is typed: the field is the prefix, and the
            // schema accepts upper case only.
            setPrefix(event.target.value.toUpperCase().slice(0, TICKET_PREFIX_MAX_LENGTH));
          }}
          error={Boolean(prefixError)}
          fullWidth
          sx={{ fontFamily: (theme) => theme.typography.mono.fontFamily }}
          slotProps={{
            input: {
              dir: 'ltr',
              autoCapitalize: 'characters',
              autoComplete: 'off',
              spellCheck: false,
              'aria-describedby': fieldDescribedBy('setup-brand-prefix', {
                hint: prefixHint,
                error: prefixError,
              }),
            },
          }}
        />
      </Field>

      <Field id="setup-brand-locale" label={t('wizard:brand.languageLabel')}>
        <Select
          native
          id="setup-brand-locale"
          value={defaultLocale}
          onChange={(event) => {
            setDefaultLocale(event.target.value as Locale);
          }}
          fullWidth
        >
          {SUPPORTED_LNGS.map((candidate) => (
            <option key={candidate} value={candidate} lang={candidate}>
              {t(`common:language.${candidate}`)}
            </option>
          ))}
        </Select>
      </Field>

      <Field
        id="setup-brand-timezone"
        label={t('wizard:brand.timezoneLabel')}
        error={timezoneError}
      >
        <Select
          native
          id="setup-brand-timezone"
          value={timezone}
          onChange={(event) => {
            setTimezone(event.target.value);
          }}
          error={Boolean(timezoneError)}
          fullWidth
        >
          {zones.map((zone) => (
            <option key={zone} value={zone}>
              {zone}
            </option>
          ))}
        </Select>
      </Field>

      <Field
        id="setup-brand-domain"
        label={t('wizard:brand.domainLabel')}
        hint={domainHint}
        error={domainError}
      >
        <OutlinedInput
          id="setup-brand-domain"
          value={helpcenterDomain}
          onChange={(event) => {
            setHelpcenterDomain(event.target.value);
          }}
          placeholder={t('wizard:brand.domainPlaceholder')}
          error={Boolean(domainError)}
          fullWidth
          slotProps={{
            input: {
              dir: 'ltr',
              autoComplete: 'off',
              spellCheck: false,
              'aria-describedby': fieldDescribedBy('setup-brand-domain', {
                hint: domainHint,
                error: domainError,
              }),
            },
          }}
        />
      </Field>
    </StepFrame>
  );
}
