import type { Locale } from '@helpdock/i18n';
import {
  AUTO_REPLY_PLACEHOLDERS,
  type AutoReplyKind,
  type AutoReplyTemplate,
  autoReplyTemplateSchema,
} from '@helpdock/schemas';
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  TextField,
  Typography,
} from '@mui/material';
import { Eye } from 'lucide-react';
import { type FormEvent, type ReactNode, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useT } from '../../../app/i18n.js';
import { useSemanticTokens } from '../../../app/tokens.js';
import { Field } from '../../../ui/field.tsx';

/**
 * The template editor of `Admin/Channels · Outgoing email`: a 720 px Dialog
 * (DESIGN §6.4) with the subject, the plain-text body, the placeholders it may
 * use, and a Preview filled with a sample ticket in the template's own
 * language.
 *
 * The preview fills the placeholders the way the api does
 * (`apps/api/src/email/email-copy.ts`): the four named ones, and nothing else.
 */

const SAMPLE: Readonly<Record<Locale, Readonly<Record<string, string>>>> = {
  en: {
    '{{ticket.number}}': 'HD-1042',
    '{{contact.first_name}}': 'Mona',
    '{{department.name}}': 'Billing',
    '{{brand.name}}': 'Helpdock',
  },
  ar: {
    '{{ticket.number}}': 'HD-1039',
    '{{contact.first_name}}': 'سارة',
    '{{department.name}}': 'الفوترة',
    '{{brand.name}}': 'Helpdock',
  },
};

export const fillSample = (text: string, locale: Locale): string =>
  Object.entries(SAMPLE[locale]).reduce(
    (filled, [placeholder, value]) => filled.replaceAll(placeholder, value),
    text,
  );

export function TemplateDialog({
  kind,
  locale,
  template,
  busy,
  onCancel,
  onSave,
}: {
  readonly kind: AutoReplyKind;
  readonly locale: Locale;
  readonly template: AutoReplyTemplate;
  readonly busy: boolean;
  onCancel(): void;
  onSave(template: AutoReplyTemplate): void;
}): ReactNode {
  const t = useT();
  const { i18n } = useTranslation();
  const tokens = useSemanticTokens();
  const id = useId();
  const [subject, setSubject] = useState(template.subject);
  const [body, setBody] = useState(template.body);
  const [wrong, setWrong] = useState(false);
  const [preview, setPreview] = useState(false);
  const dir = i18n.dir(locale);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    // The dialog is portalled, but React still bubbles its submit through the
    // Auto-replies form it is rendered from; that form must not save too.
    event.stopPropagation();
    const parsed = autoReplyTemplateSchema.safeParse({ subject, body });
    setWrong(!parsed.success);
    if (parsed.success) {
      onSave(parsed.data);
    }
  };

  const title = t('channels:template.title', {
    kind: t(`channels:template.kinds.${kind}`),
    language: t(`channels:template.languages.${locale}`),
  });

  return (
    <Dialog
      open
      onClose={onCancel}
      fullWidth
      aria-labelledby={`${id}-title`}
      slotProps={{ paper: { sx: { maxWidth: 720 } } }}
    >
      <Box component="form" noValidate onSubmit={submit}>
        <DialogTitle id={`${id}-title`} sx={{ fontSize: 16, fontWeight: 600 }}>
          {title}
        </DialogTitle>
        <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <Field
            id={`${id}-subject`}
            label={t('channels:template.subject')}
            error={wrong ? t('channels:template.required') : undefined}
          >
            <TextField
              id={`${id}-subject`}
              size="small"
              value={subject}
              error={wrong && subject.trim() === ''}
              onChange={(event) => {
                setSubject(event.target.value);
              }}
              slotProps={{ htmlInput: { maxLength: 200, dir, lang: locale } }}
            />
          </Field>
          <Field
            id={`${id}-body`}
            label={t('channels:template.body')}
            hint={t('channels:template.placeholders', {
              list: AUTO_REPLY_PLACEHOLDERS.join(', '),
            })}
          >
            <TextField
              id={`${id}-body`}
              multiline
              minRows={6}
              value={body}
              error={wrong && body.trim() === ''}
              onChange={(event) => {
                setBody(event.target.value);
              }}
              slotProps={{ htmlInput: { maxLength: 4000, dir, lang: locale } }}
            />
          </Field>

          {preview ? (
            <Box
              component="section"
              aria-label={t('channels:template.previewHeading')}
              dir={dir}
              lang={locale}
              sx={{
                padding: 4,
                borderRadius: '6px',
                border: `1px solid ${tokens['border.default']}`,
                backgroundColor: tokens['bg.canvas'],
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
              }}
            >
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                {t('channels:template.previewHeading')}
              </Typography>
              <Typography variant="bodyStrong">{fillSample(subject, locale)}</Typography>
              <Typography variant="body2" sx={{ whiteSpace: 'pre-line' }}>
                {fillSample(body, locale)}
              </Typography>
            </Box>
          ) : null}
        </DialogContent>
        <DialogActions sx={{ padding: 4, gap: 2 }}>
          <Button variant="text" onClick={onCancel} disabled={busy}>
            {t('channels:template.cancel')}
          </Button>
          <Button
            variant="outlined"
            startIcon={<Eye size={14} aria-hidden="true" />}
            aria-pressed={preview}
            onClick={() => {
              setPreview((held) => !held);
            }}
          >
            {preview ? t('channels:template.hidePreview') : t('channels:template.preview')}
          </Button>
          <Button type="submit" variant="contained" disabled={busy}>
            {t('channels:template.save')}
          </Button>
        </DialogActions>
      </Box>
    </Dialog>
  );
}
