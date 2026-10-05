import type { Attachment, DownloadVariant } from '@helpdock/schemas';
import { Box, CircularProgress, IconButton, Typography } from '@mui/material';
import { Pause, Play } from 'lucide-react';
import { type ReactNode, useRef, useState } from 'react';
import { useT } from '../../../app/i18n.js';
import { useSemanticTokens } from '../../../app/tokens.js';
import { useAttachmentUploader } from '../../../auth/session.tsx';
import { useToast } from '../../../ui/toasts.tsx';

/**
 * DESIGN §6.3 VoiceNote (M6-03, `Admin/Ticket-Telegram`): a contact's voice
 * message as a round outlined play button, an `aria-hidden` waveform, its
 * length and the time. The five-minute URL is asked for on the first press,
 * never for a thread that is only being read. The transcript under it is
 * M7-09's; an attachment carries none yet, so nothing is drawn for it.
 */

const BARS = 18;

/** Bar heights, 6–18 px, steady for one file: a picture, not a measurement. */
export const waveform = (seed: string): number[] =>
  Array.from({ length: BARS }, (_, index) => {
    const code = seed.charCodeAt((index * 7) % seed.length) + index * 13;
    return 6 + (code % 13);
  });

/** `0:14`, `1:05`. Latin digits in both locales (DESIGN §7). */
export const voiceDuration = (ms: number): string => {
  const seconds = Math.round(ms / 1_000);
  return `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, '0')}`;
};

const playable = (attachment: Attachment): DownloadVariant =>
  attachment.variants.opus === undefined ? 'original' : 'opus';

export function VoiceNote({
  brandId,
  attachment,
  time,
}: {
  readonly brandId: string;
  readonly attachment: Attachment;
  /** The message's time, as the thread writes it. */
  readonly time: string;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const uploader = useAttachmentUploader();
  const toast = useToast();
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const durationMs =
    attachment.variants.opus?.durationMs ?? attachment.variants.original?.durationMs;
  const duration = durationMs === undefined ? '' : voiceDuration(durationMs);

  const toggle = async (): Promise<void> => {
    const element = audio.current;
    if (element === null) {
      return;
    }
    if (playing) {
      element.pause();
      return;
    }
    try {
      if (element.getAttribute('src') === null) {
        setLoading(true);
        element.src = await uploader.downloadUrl(
          brandId,
          attachment.ticketId,
          attachment.id,
          playable(attachment),
        );
      }
      await element.play();
    } catch {
      toast({ tone: 'danger', message: t('tickets:telegram.voice.loadFailed') });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 3,
        paddingBlock: 2,
        paddingInline: 3,
        borderRadius: '6px',
        border: `1px solid ${tokens['border.default']}`,
        backgroundColor: tokens['bg.surface'],
      }}
    >
      <IconButton
        aria-label={t(playing ? 'tickets:telegram.voice.pause' : 'tickets:telegram.voice.play', {
          duration,
        })}
        disabled={loading}
        onClick={() => {
          void toggle();
        }}
        sx={{
          width: 32,
          height: 32,
          border: `1px solid ${tokens['border.strong']}`,
          borderRadius: '999px',
        }}
      >
        {loading ? (
          <CircularProgress size={14} aria-hidden="true" />
        ) : playing ? (
          <Pause size={14} aria-hidden="true" />
        ) : (
          <Play size={14} aria-hidden="true" />
        )}
      </IconButton>
      <Box aria-hidden="true" sx={{ display: 'flex', alignItems: 'center', gap: '2px' }}>
        {waveform(attachment.id).map((height, index) => (
          <Box
            // The bars are a fixed picture; their order is their identity.
            // biome-ignore lint/suspicious/noArrayIndexKey: see above.
            key={index}
            sx={{
              width: 2,
              height,
              borderRadius: '999px',
              backgroundColor: tokens['text.disabled'],
            }}
          />
        ))}
      </Box>
      <Typography variant="mono" component="span" sx={{ fontSize: 12 }}>
        {duration}
      </Typography>
      <Typography
        variant="mono"
        component="span"
        sx={{ fontSize: 12, color: 'text.secondary', marginInlineStart: 'auto' }}
      >
        {time}
      </Typography>
      {/* biome-ignore lint/a11y/useMediaCaption: a customer's voice note has no captions; its transcript (M7-09) is the text alternative. */}
      <audio
        ref={audio}
        preload="none"
        onPlay={() => {
          setPlaying(true);
        }}
        onPause={() => {
          setPlaying(false);
        }}
        onEnded={() => {
          setPlaying(false);
        }}
      />
    </Box>
  );
}
