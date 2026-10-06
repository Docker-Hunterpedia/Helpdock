import { Box, Button, Typography } from '@mui/material';
import { Languages, ShieldCheck } from 'lucide-react';
import type { ReactNode } from 'react';
import { useT } from '../../../app/i18n.js';
import { useSemanticTokens } from '../../../app/tokens.js';
import { redactionParts } from './format.js';

/**
 * Under a contact message that a model reads (M7-05, M7-08; DESIGN §6.3
 * RedactionToken): "Translated from Arabic by AI · Show original" and "1 item
 * redacted before AI · Show redacted", each a pressed-state toggle. Off shows
 * what the customer wrote; on shows the translation, or what the model
 * received. Agents only: the ticket view does not draw it for a Viewer.
 */

function Toggle({
  pressed,
  label,
  onClick,
}: {
  readonly pressed: boolean;
  readonly label: string;
  onClick(): void;
}): ReactNode {
  const tokens = useSemanticTokens();
  return (
    <Button
      size="small"
      variant="outlined"
      aria-pressed={pressed}
      onClick={onClick}
      sx={{
        height: 28,
        fontSize: 12,
        color: 'text.primary',
        backgroundColor: pressed ? tokens['action.primary.tint'] : tokens['bg.surface'],
        borderColor: pressed ? tokens['action.primary'] : tokens['border.default'],
      }}
    >
      {label}
    </Button>
  );
}

export interface TranslationFact {
  /** The language the message was written in. */
  readonly from: 'en' | 'ar';
  /** `none` until translated; then the translation, or the original by "Show original". */
  readonly state: 'none' | 'translated' | 'original';
  readonly busy: boolean;
  onTranslate(): void;
  onToggleOriginal(): void;
}

export interface RedactionFact {
  readonly count: number;
  readonly shown: boolean;
  onToggle(): void;
}

export function MessageAiFacts({
  translation,
  redaction,
}: {
  readonly translation?: TranslationFact | undefined;
  readonly redaction?: RedactionFact | undefined;
}): ReactNode {
  const t = useT();
  if (translation === undefined && redaction === undefined) {
    return null;
  }
  const line = { display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' } as const;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, color: 'text.secondary' }}>
      {translation === undefined ? null : (
        <Box sx={line}>
          <Languages size={14} aria-hidden="true" />
          <Typography variant="caption">
            {t(
              translation.state === 'none'
                ? 'tickets:assist.writtenIn'
                : 'tickets:assist.translatedFrom',
              { language: t(`tickets:assist.languages.${translation.from}`) },
            )}
          </Typography>
          {translation.state === 'none' ? (
            <Button
              size="small"
              variant="outlined"
              disabled={translation.busy}
              onClick={translation.onTranslate}
              sx={{ height: 28, fontSize: 12 }}
            >
              {t('tickets:assist.translate')}
            </Button>
          ) : (
            <Toggle
              pressed={translation.state === 'original'}
              label={t('tickets:assist.showOriginal')}
              onClick={translation.onToggleOriginal}
            />
          )}
        </Box>
      )}
      {redaction === undefined ? null : (
        <Box sx={line}>
          <ShieldCheck size={14} aria-hidden="true" />
          <Typography variant="caption">
            {t('tickets:assist.redactedBeforeAi', { count: redaction.count })}
          </Typography>
          <Toggle
            pressed={redaction.shown}
            label={t('tickets:assist.showRedacted')}
            onClick={redaction.onToggle}
          />
        </Box>
      )}
    </Box>
  );
}

/** A message as plain text, with every placeholder drawn as a RedactionToken. */
export function RedactedText({ text }: { readonly text: string }): ReactNode {
  const tokens = useSemanticTokens();
  return (
    <Box component="p" dir="auto" sx={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 14 }}>
      {redactionParts(text).map((part, index) =>
        part.placeholder ? (
          <Box
            // The parts are a fixed split of one string; their order is their identity.
            // biome-ignore lint/suspicious/noArrayIndexKey: see above.
            key={index}
            component="span"
            sx={(theme) => ({
              ...theme.typography.mono,
              fontSize: 12,
              paddingInline: 1,
              borderRadius: '4px',
              backgroundColor: tokens['bg.muted'],
              border: `1px solid ${tokens['border.strong']}`,
            })}
          >
            {part.text}
          </Box>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: see above.
          <span key={index}>{part.text}</span>
        ),
      )}
    </Box>
  );
}

/** A translation in place of the message, in its own language and direction. */
export function TranslatedText({
  text,
  locale,
}: {
  readonly text: string;
  readonly locale: 'en' | 'ar';
}): ReactNode {
  return (
    <Box
      component="p"
      lang={locale}
      dir={locale === 'ar' ? 'rtl' : 'ltr'}
      sx={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 14 }}
    >
      {text}
    </Box>
  );
}
