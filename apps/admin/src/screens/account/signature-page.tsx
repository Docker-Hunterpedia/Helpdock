import type { Locale } from '@helpdock/i18n';
import {
  EMAIL_SIGNATURE_MAX_LENGTH,
  EMAIL_SIGNATURE_MAX_LINES,
  type EmailSignature,
} from '@helpdock/schemas';
import { Box, Button, TextField, Typography } from '@mui/material';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useT } from '../../app/i18n.js';
import { useSemanticTokens } from '../../app/tokens.js';
import { useEmailApi } from '../../auth/session.tsx';
import { emailKeys } from '../../email/api.js';
import { PageHeader } from '../../shell/page-header.tsx';
import { Field } from '../../ui/field.tsx';
import { useEmailAction } from '../admin/channels/section-card.tsx';
import { AccountTabs } from './account-tabs.tsx';

/**
 * Your account › Email signature (artboard `AdminSignature`, M2-05): the lines
 * added under a person's public email replies, in English and in Arabic, with
 * a preview of the end of a reply in each language that updates as they type.
 *
 * Over six lines, the field turns red and says so, and Save stays enabled so
 * the error is announced when it is pressed (the artboard's invalid state).
 */

const lines = (value: string): readonly string[] =>
  value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');

export const tooManyLines = (value: string): boolean =>
  value.replace(/\s+$/u, '').split(/\r?\n/).length > EMAIL_SIGNATURE_MAX_LINES;

export function SignaturePage(): ReactNode {
  const t = useT();
  const api = useEmailApi();
  const tokens = useSemanticTokens();
  const queryClient = useQueryClient();
  const id = useId();

  const stored = useQuery({ queryKey: emailKeys.signature(), queryFn: () => api.signature() });
  const [draft, setDraft] = useState<EmailSignature>({ en: '', ar: '' });
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    if (stored.data !== undefined) {
      setDraft(stored.data);
    }
  }, [stored.data]);

  const save = useEmailAction(
    (request: EmailSignature) => api.saveSignature(request),
    t('me:signature.saved'),
    (saved: EmailSignature) => {
      queryClient.setQueryData(emailKeys.signature(), saved);
      setChecked(false);
    },
  );

  const wrong = { en: checked && tooManyLines(draft.en), ar: checked && tooManyLines(draft.ar) };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setChecked(true);
    if (!tooManyLines(draft.en) && !tooManyLines(draft.ar)) {
      save.mutate(draft);
    }
  };

  const card = {
    borderRadius: '10px',
    border: `1px solid ${tokens['border.default']}`,
    backgroundColor: tokens['bg.surface'],
  } as const;

  return (
    <>
      <PageHeader title={t('me:signature.pageTitle')} caption={t('me:signature.pageCaption')} />
      <AccountTabs current="signature" />

      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: 'minmax(0, 1fr)', lg: 'minmax(0, 640px) minmax(0, 420px)' },
          gap: 6,
          alignItems: 'start',
        }}
      >
        <Box
          component="form"
          noValidate
          onSubmit={submit}
          aria-labelledby={`${id}-heading`}
          sx={{ ...card, display: 'flex', flexDirection: 'column' }}
        >
          <Box
            sx={{
              paddingBlock: 4,
              paddingInline: 5,
              borderBlockEnd: `1px solid ${tokens['border.default']}`,
            }}
          >
            <Typography id={`${id}-heading`} variant="h3" component="h2" sx={{ fontSize: 16 }}>
              {t('me:signature.heading')}
            </Typography>
            <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: 13 }}>
              {t('me:signature.caption')}
            </Typography>
          </Box>

          <Box sx={{ padding: 5, display: 'flex', flexDirection: 'column', gap: 4 }}>
            <Field
              id={`${id}-en`}
              label={t('me:signature.en')}
              hint={t('me:signature.enHint')}
              error={wrong.en ? t('me:signature.tooManyLines') : undefined}
            >
              <TextField
                id={`${id}-en`}
                multiline
                minRows={4}
                value={draft.en}
                error={wrong.en}
                onChange={(event) => {
                  setDraft((held) => ({ ...held, en: event.target.value }));
                }}
                slotProps={{
                  htmlInput: {
                    dir: 'ltr',
                    lang: 'en',
                    maxLength: EMAIL_SIGNATURE_MAX_LENGTH,
                    'aria-describedby': `${id}-en-${wrong.en ? 'error' : 'hint'}`,
                    'aria-invalid': wrong.en,
                  },
                }}
              />
            </Field>
            <Field
              id={`${id}-ar`}
              label={`${t('me:signature.ar')} · ${t('me:signature.arNative')}`}
              hint={t('me:signature.arHint')}
              error={wrong.ar ? t('me:signature.tooManyLines') : undefined}
            >
              <TextField
                id={`${id}-ar`}
                multiline
                minRows={4}
                value={draft.ar}
                error={wrong.ar}
                onChange={(event) => {
                  setDraft((held) => ({ ...held, ar: event.target.value }));
                }}
                slotProps={{
                  htmlInput: {
                    dir: 'rtl',
                    lang: 'ar',
                    maxLength: EMAIL_SIGNATURE_MAX_LENGTH,
                    'aria-describedby': `${id}-ar-${wrong.ar ? 'error' : 'hint'}`,
                    'aria-invalid': wrong.ar,
                  },
                }}
              />
            </Field>
          </Box>

          <Box
            sx={{
              paddingBlock: 3,
              paddingInline: 5,
              display: 'flex',
              justifyContent: 'flex-end',
              gap: 2,
              borderBlockStart: `1px solid ${tokens['border.default']}`,
              backgroundColor: tokens['bg.canvas'],
              borderEndStartRadius: '10px',
              borderEndEndRadius: '10px',
            }}
          >
            <Button
              variant="text"
              disabled={save.isPending || stored.data === undefined}
              onClick={() => {
                if (stored.data !== undefined) {
                  setDraft(stored.data);
                  setChecked(false);
                }
              }}
            >
              {t('me:signature.discard')}
            </Button>
            <Button type="submit" variant="contained" disabled={save.isPending}>
              {t('me:signature.save')}
            </Button>
          </Box>
        </Box>

        <Box
          component="aside"
          aria-labelledby={`${id}-preview`}
          sx={{ ...card, padding: 5, display: 'flex', flexDirection: 'column', gap: 4 }}
        >
          <Box>
            <Typography id={`${id}-preview`} variant="h3" component="h2" sx={{ fontSize: 16 }}>
              {t('me:signature.previewHeading')}
            </Typography>
            <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: 13 }}>
              {t('me:signature.previewCaption')}
            </Typography>
          </Box>
          <PreviewBlock locale="en" signature={draft.en} />
          <PreviewBlock locale="ar" signature={draft.ar.trim() === '' ? draft.en : draft.ar} />
        </Box>
      </Box>
    </>
  );
}

/** The end of a reply in one language, drawn in that language whatever the screen's is. */
function PreviewBlock({
  locale,
  signature,
}: {
  readonly locale: Locale;
  readonly signature: string;
}): ReactNode {
  const t = useT();
  const { i18n } = useTranslation();
  const tokens = useSemanticTokens();
  const sample = i18n.getFixedT(locale, 'me');
  const signatureLines = lines(signature);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      <Typography variant="caption" sx={{ color: 'text.secondary' }}>
        {t(`me:signature.${locale}`)}
      </Typography>
      <Box
        dir={i18n.dir(locale)}
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
        <Typography variant="body2">{sample('signature.sampleGreeting')}</Typography>
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          {sample('signature.sampleBody')}
        </Typography>
        {signatureLines.length === 0 ? null : (
          <Box
            sx={{
              paddingBlockStart: 2,
              borderBlockStart: `1px solid ${tokens['border.default']}`,
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            {signatureLines.map((line, index) => (
              <Typography
                // Lines of one signature never reorder while it is shown.
                // biome-ignore lint/suspicious/noArrayIndexKey: see above.
                key={index}
                variant="body2"
                sx={index === 0 ? { fontWeight: 500 } : { color: 'text.secondary' }}
              >
                {line}
              </Typography>
            ))}
          </Box>
        )}
      </Box>
    </Box>
  );
}
