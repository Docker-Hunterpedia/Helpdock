import { TELEGRAM_WELCOME_MAX_LENGTH } from '@helpdock/schemas';
import { Box, TextField, Typography } from '@mui/material';
import type { ReactNode } from 'react';
import { useId } from 'react';
import { useT } from '../../../../app/i18n.js';
import { Field, fieldDescribedBy } from '../../../../ui/field.tsx';
import { Switch } from '../../../../ui/switch.tsx';
import type { BotDraft } from './bot-draft.js';
import { FormSection } from './form-section.tsx';

/**
 * Welcome and language (M6-04): whether `/start` asks for a language, the
 * question it asks with the two buttons — one text for both languages, because
 * the contact's is not known yet — and the welcome per language, sent once the
 * language is chosen.
 */
export function WelcomeSection({
  draft,
  errors,
  onChange,
}: {
  readonly draft: BotDraft;
  readonly errors: {
    readonly languagePrompt?: string | undefined;
    readonly welcomeEn?: string | undefined;
    readonly welcomeAr?: string | undefined;
  };
  onChange<K extends 'languagePick' | 'languagePrompt' | 'welcomeEn' | 'welcomeAr'>(
    key: K,
    value: BotDraft[K],
  ): void;
}): ReactNode {
  const t = useT();
  const promptId = useId();
  const hint = t('channels:telegram.detail.welcome.hint', { max: TELEGRAM_WELCOME_MAX_LENGTH });
  const promptHint = t('channels:telegram.detail.welcome.promptHint');

  return (
    <FormSection
      heading={t('channels:telegram.detail.welcome.heading')}
      caption={t('channels:telegram.detail.welcome.caption')}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 3 }}>
        <Switch
          checked={draft.languagePick}
          label={t('channels:telegram.detail.welcome.languagePick')}
          onChange={(checked) => {
            onChange('languagePick', checked);
          }}
        />
        <Typography component="span" sx={{ fontSize: 14 }} aria-hidden="true">
          {t('channels:telegram.detail.welcome.languagePick')}
        </Typography>
      </Box>

      <Field
        id={promptId}
        label={t('channels:telegram.detail.welcome.prompt')}
        hint={promptHint}
        error={errors.languagePrompt}
      >
        <TextField
          id={promptId}
          value={draft.languagePrompt}
          disabled={!draft.languagePick}
          error={errors.languagePrompt !== undefined}
          onChange={(event) => {
            onChange('languagePrompt', event.target.value);
          }}
          slotProps={{
            htmlInput: {
              dir: 'auto',
              'aria-describedby': fieldDescribedBy(promptId, {
                hint: promptHint,
                error: errors.languagePrompt,
              }),
              'aria-invalid': errors.languagePrompt !== undefined,
            },
          }}
        />
      </Field>

      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'repeat(2, minmax(0, 1fr))' },
          gap: 4,
        }}
      >
        <WelcomeField
          label={t('channels:telegram.detail.welcome.en')}
          lang="en"
          value={draft.welcomeEn}
          hint={hint}
          error={errors.welcomeEn}
          onChange={(value) => {
            onChange('welcomeEn', value);
          }}
        />
        <WelcomeField
          label={t('channels:telegram.detail.welcome.ar')}
          lang="ar"
          value={draft.welcomeAr}
          hint={hint}
          error={errors.welcomeAr}
          onChange={(value) => {
            onChange('welcomeAr', value);
          }}
        />
      </Box>
    </FormSection>
  );
}

function WelcomeField({
  label,
  lang,
  value,
  hint,
  error,
  onChange,
}: {
  readonly label: string;
  readonly lang: 'en' | 'ar';
  readonly value: string;
  readonly hint: string;
  readonly error: string | undefined;
  onChange(value: string): void;
}): ReactNode {
  const id = useId();

  return (
    <Field id={id} label={label} hint={hint} error={error}>
      <TextField
        id={id}
        multiline
        minRows={3}
        value={value}
        error={error !== undefined}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        slotProps={{
          htmlInput: {
            lang,
            dir: lang === 'ar' ? 'rtl' : 'ltr',
            'aria-describedby': fieldDescribedBy(id, { hint, error }),
            'aria-invalid': error !== undefined,
          },
        }}
      />
    </Field>
  );
}
