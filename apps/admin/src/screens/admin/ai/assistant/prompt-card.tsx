import {
  AI_SYSTEM_PROMPT_MAX_LENGTH,
  type BrandAiPromptUpdate,
  type BrandAiSettings,
} from '@helpdock/schemas';
import { Box, Button, TextField, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import { useQueryClient } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useEffect, useId, useState } from 'react';
import { aiKeys } from '../../../../ai/api.js';
import { useAiApi } from '../../../../ai/context.tsx';
import { useT } from '../../../../app/i18n.js';
import { Field } from '../../../../ui/field.tsx';
import { SectionCard } from '../../channels/section-card.tsx';
import { useAiAction } from '../use-ai-action.js';

type Language = 'en' | 'ar';

/**
 * The System prompt card of `Admin/AI-Assistant`: tone, language policy and
 * forbidden topics, one prompt per conversation language, switched with a
 * SegmentedControl. Admins and Team Leaders edit it (REQUIREMENTS §4.7). The
 * Arabic prompt may stay empty, in which case the English one serves both.
 */
export function PromptCard({
  brandId,
  settings,
}: {
  readonly brandId: string;
  readonly settings: BrandAiSettings;
}): ReactNode {
  const t = useT();
  const api = useAiApi();
  const queryClient = useQueryClient();
  const id = useId();
  const [language, setLanguage] = useState<Language>('en');
  const [prompts, setPrompts] = useState<Record<Language, string>>(() => promptsOf(settings));

  useEffect(() => {
    setPrompts(promptsOf(settings));
  }, [settings]);

  const save = useAiAction(
    (request: BrandAiPromptUpdate) => api.savePrompt(brandId, request),
    t('aiSettings:prompt.saved'),
    (saved) => {
      queryClient.setQueryData(aiKeys.brand(brandId), saved);
    },
  );
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    save.mutate({ systemPrompt: prompts.en, systemPromptAr: prompts.ar });
  };

  const fieldId = `${id}-prompt-${language}`;
  const value = prompts[language];

  return (
    <SectionCard
      id={`${id}-prompt`}
      heading={t('aiSettings:prompt.heading')}
      caption={t('aiSettings:prompt.caption')}
      aside={
        <ToggleButtonGroup
          exclusive
          size="small"
          value={language}
          aria-label={t('aiSettings:prompt.languageLabel')}
          onChange={(_event, next: Language | null) => {
            if (next !== null) {
              setLanguage(next);
            }
          }}
        >
          <ToggleButton value="en">{t('aiSettings:languages.en')}</ToggleButton>
          <ToggleButton value="ar" lang="ar">
            {t('aiSettings:languages.arNative')}
          </ToggleButton>
        </ToggleButtonGroup>
      }
      onSubmit={submit}
      footer={
        <>
          <Button
            variant="text"
            disabled={save.isPending}
            onClick={() => {
              setPrompts(promptsOf(settings));
            }}
          >
            {t('aiSettings:discard')}
          </Button>
          <Button type="submit" variant="contained" disabled={save.isPending}>
            {t('aiSettings:prompt.save')}
          </Button>
        </>
      }
    >
      <Field
        id={fieldId}
        label={t(`aiSettings:prompt.label.${language}`)}
        hint={language === 'ar' ? t('aiSettings:prompt.arHint') : undefined}
      >
        <TextField
          id={fieldId}
          multiline
          minRows={6}
          size="small"
          value={value}
          onChange={(event) => {
            setPrompts((held) => ({ ...held, [language]: event.target.value }));
          }}
          slotProps={{
            htmlInput: {
              lang: language,
              dir: language === 'ar' ? 'rtl' : 'ltr',
              maxLength: AI_SYSTEM_PROMPT_MAX_LENGTH,
              style: { fontFamily: 'var(--hd-font-mono, monospace)', fontSize: 13 },
            },
          }}
        />
      </Field>
      <Box sx={{ display: 'flex', gap: 3, justifyContent: 'space-between' }}>
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          {t('aiSettings:prompt.hint')}
        </Typography>
        <Typography
          variant="mono"
          component="span"
          sx={{ fontSize: 12, color: 'text.secondary', whiteSpace: 'nowrap' }}
        >
          {t('aiSettings:prompt.count', { count: value.length })}
        </Typography>
      </Box>
    </SectionCard>
  );
}

const promptsOf = (settings: BrandAiSettings): Record<Language, string> => ({
  en: settings.systemPrompt,
  ar: settings.systemPromptAr,
});
