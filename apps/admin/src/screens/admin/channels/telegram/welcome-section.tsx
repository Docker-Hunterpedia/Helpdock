import { TELEGRAM_WELCOME_MAX_LENGTH } from '@helpdock/schemas';
import { Box, TextField, Typography } from '@mui/material';
import type { ReactNode } from 'react';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { useT } from '../../../../app/i18n.js';
import { useSemanticTokens } from '../../../../app/tokens.js';
import { Field, fieldDescribedBy } from '../../../../ui/field.tsx';
import { Switch } from '../../../../ui/switch.tsx';
import type { BotDraft } from './bot-draft.js';
import { FormSection } from './form-section.tsx';

/**
 * Welcome and language (M6-04): whether `/start` offers the two language
 * buttons, the question that goes with them — the bot's catalog text, shown
 * here in both languages because the contact's is not known yet — and the
 * welcome per language.
 */
export function WelcomeSection({
  draft,
  errors,
  onChange,
}: {
  readonly draft: BotDraft;
  readonly errors: {
    readonly welcomeEn?: string | undefined;
    readonly welcomeAr?: string | undefined;
  };
  onChange<K extends 'languagePick' | 'welcomeEn' | 'welcomeAr'>(key: K, value: BotDraft[K]): void;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const promptId = useId();
  const { i18n } = useTranslation();
  const prompt = (['en', 'ar'] as const)
    .map((lng) => i18n.getFixedT(lng, 'telegram')('bot.languagePrompt'))
    .join(' · ');
  const hint = t('channels:telegram.detail.welcome.hint', { max: TELEGRAM_WELCOME_MAX_LENGTH });

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

      {draft.languagePick ? (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <Typography id={promptId} component="h3" sx={{ fontSize: 13, fontWeight: 500 }}>
            {t('channels:telegram.detail.welcome.prompt')}
          </Typography>
          <Box
            aria-labelledby={promptId}
            role="note"
            sx={{
              paddingBlock: 2,
              paddingInline: 3,
              borderRadius: '6px',
              border: `1px solid ${tokens['border.default']}`,
              backgroundColor: tokens['bg.canvas'],
              fontSize: 14,
            }}
          >
            <bdi>{prompt}</bdi>
          </Box>
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            {t('channels:telegram.detail.welcome.promptHint')}
          </Typography>
        </Box>
      ) : null}

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
