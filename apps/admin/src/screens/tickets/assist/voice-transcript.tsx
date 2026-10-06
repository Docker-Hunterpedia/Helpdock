import type { Transcript } from '@helpdock/schemas';
import { Box, Button, Typography } from '@mui/material';
import { Mic } from 'lucide-react';
import { createContext, type ReactNode, useContext, useId, useState } from 'react';
import { useT } from '../../../app/i18n.js';
import { useSemanticTokens } from '../../../app/tokens.js';

/**
 * The transcript half of DESIGN §6.3 VoiceNote (M7-09): a "Transcript"
 * toggle under the player, "Transcribing…" while the job runs, and, open, the
 * text in its own language with "Transcript · AI · Arabic · staff only" and
 * a Translate action. A transcript is shown to staff only and never goes
 * back to the visitor.
 *
 * The ticket view provides the transcripts through {@link TranscriptsProvider};
 * a VoiceNote outside one draws no transcript.
 */

export interface TranscriptsValue {
  transcriptOf(attachmentId: string): Transcript | undefined;
  /** The transcript in the other language, or a rejection the caller reports. */
  translate(attachmentId: string, target: 'en' | 'ar'): Promise<string>;
}

const TranscriptsContext = createContext<TranscriptsValue | null>(null);

export function TranscriptsProvider({
  value,
  children,
}: {
  readonly value: TranscriptsValue;
  readonly children: ReactNode;
}): ReactNode {
  return <TranscriptsContext.Provider value={value}>{children}</TranscriptsContext.Provider>;
}

export function VoiceTranscript({ attachmentId }: { readonly attachmentId: string }): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const transcripts = useContext(TranscriptsContext);
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const [translated, setTranslated] = useState<string | null>(null);
  const [translating, setTranslating] = useState(false);
  const [failed, setFailed] = useState(false);
  const transcript = transcripts?.transcriptOf(attachmentId);

  if (transcripts === null || transcript === undefined || transcript.status === 'failed') {
    return null;
  }
  const locale = transcript.locale ?? 'en';
  const target = locale === 'ar' ? 'en' : 'ar';
  const shownLocale = translated === null ? locale : target;

  const translate = async (): Promise<void> => {
    setTranslating(true);
    setFailed(false);
    try {
      setTranslated(await transcripts.translate(attachmentId, target));
    } catch {
      setFailed(true);
    } finally {
      setTranslating(false);
    }
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, marginBlockStart: 2 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        <Button
          size="small"
          variant="outlined"
          aria-expanded={open}
          aria-controls={panelId}
          disabled={transcript.status === 'pending'}
          startIcon={<Mic size={14} aria-hidden="true" />}
          onClick={() => {
            setOpen((current) => !current);
          }}
          sx={{
            height: 24,
            fontSize: 12,
            fontWeight: 500,
            color: 'text.secondary',
            borderColor: tokens['border.default'],
          }}
        >
          {t('tickets:assist.transcript.toggle')}
        </Button>
        {transcript.status === 'pending' ? (
          <Typography variant="caption" role="status" sx={{ color: 'text.secondary' }}>
            {t('tickets:assist.transcript.pending')}
          </Typography>
        ) : null}
      </Box>
      {open && transcript.text !== null ? (
        <Box
          id={panelId}
          sx={{
            borderRadius: '6px',
            backgroundColor: tokens['bg.canvas'],
            border: `1px solid ${tokens['border.default']}`,
            padding: '8px 12px',
            display: 'flex',
            flexDirection: 'column',
            gap: 1,
          }}
        >
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              {t('tickets:assist.transcript.caption', {
                language:
                  transcript.locale === null
                    ? (transcript.language ?? t('tickets:assist.transcript.unknown'))
                    : t(`tickets:assist.languages.${transcript.locale}`),
              })}
            </Typography>
            <Button
              size="small"
              variant="text"
              disabled={translating}
              aria-pressed={translated !== null}
              onClick={() => {
                if (translated === null) {
                  void translate();
                } else {
                  setTranslated(null);
                }
              }}
              sx={{ marginInlineStart: 'auto', height: 24, fontSize: 12 }}
            >
              {t(translated === null ? 'tickets:assist.translate' : 'tickets:assist.showOriginal')}
            </Button>
          </Box>
          {failed ? (
            <Typography variant="caption" role="alert" sx={{ color: tokens['status.danger.text'] }}>
              {t('tickets:assist.failed.provider-failed')}
            </Typography>
          ) : null}
          <Typography
            component="p"
            lang={shownLocale}
            dir={shownLocale === 'ar' ? 'rtl' : 'ltr'}
            sx={{ fontSize: 14, margin: 0 }}
          >
            {translated ?? transcript.text}
          </Typography>
        </Box>
      ) : null}
    </Box>
  );
}
