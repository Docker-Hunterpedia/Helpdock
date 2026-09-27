import { useEffect, useRef, useState } from 'preact/hooks';
import { formatDuration } from '../format.js';
import type { Translate } from '../i18n/translator.js';
import { Icon } from '../ui/icons.js';
import { pickRecordingFormat, recordingName } from './mime.js';

/**
 * The recording composer (`WidgetStatesEN` column 3, M4-07), a lazy chunk:
 * it replaces the input with a waveform bar, the elapsed time in mono, cancel
 * and stop-and-send. Recording stops by itself at the policy's limit.
 */
export interface RecorderProps {
  readonly maxSeconds: number;
  readonly t: Translate;
  readonly onCancel: () => void;
  readonly onDone: (blob: Blob, name: string) => void;
}

const BARS = [6, 12, 18, 10, 16, 22, 14, 8, 18, 12, 6, 10, 16];

export default function Recorder({ maxSeconds, t, onCancel, onDone }: RecorderProps) {
  const [elapsed, setElapsed] = useState(0);
  const [denied, setDenied] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const cancelled = useRef(false);
  const stopButton = useRef<HTMLButtonElement>(null);
  // The parent passes fresh callbacks on every render; recording must not restart for that.
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => {
    const format = pickRecordingFormat((mime) => MediaRecorder.isTypeSupported(mime));
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setInterval> | undefined;

    navigator.mediaDevices.getUserMedia({ audio: true }).then(
      (media) => {
        stream = media;
        const chunks: Blob[] = [];
        const active = new MediaRecorder(media, format ? { mimeType: format.mime } : {});
        active.ondataavailable = (event) => chunks.push(event.data);
        active.onstop = () => {
          for (const track of media.getTracks()) {
            track.stop();
          }
          if (!cancelled.current) {
            const type = (active.mimeType || format?.mime || 'audio/webm').split(';')[0] ?? '';
            done.current(new Blob(chunks, { type }), recordingName(format?.extension ?? 'webm'));
          }
        };
        active.start();
        recorder.current = active;
        stopButton.current?.focus();
        const started = Date.now();
        timer = setInterval(() => {
          const seconds = Math.floor((Date.now() - started) / 1000);
          setElapsed(seconds);
          if (seconds >= maxSeconds && active.state === 'recording') {
            active.stop();
          }
        }, 250);
      },
      () => setDenied(true),
    );

    return () => {
      clearInterval(timer);
      if (recorder.current?.state === 'recording') {
        cancelled.current = true;
        recorder.current.stop();
      }
      for (const track of stream?.getTracks() ?? []) {
        track.stop();
      }
    };
  }, [maxSeconds]);

  const cancel = () => {
    cancelled.current = true;
    recorder.current?.stop();
    onCancel();
  };

  const stop = (event: Event) => {
    event.preventDefault();
    if (recorder.current?.state === 'recording') {
      recorder.current.stop();
    }
  };

  if (denied) {
    return (
      <div class="hd-alert hd-alert-danger hd-composer-alert" role="alert">
        <Icon name="alert" size={16} />
        <span>{t('voice.denied')}</span>
        <button
          type="button"
          class="hd-icon-button"
          aria-label={t('voice.cancel')}
          onClick={onCancel}
        >
          <Icon name="x" size={16} />
        </button>
      </div>
    );
  }

  return (
    <form class="hd-composer" aria-label={t('voice.form')} onSubmit={stop}>
      <button type="button" class="hd-icon-button" aria-label={t('voice.cancel')} onClick={cancel}>
        <Icon name="x" />
      </button>
      <div class="hd-recording">
        <span class="hd-recording-dot" aria-hidden="true" />
        <span class="hd-recording-label">{t('voice.recording')}</span>
        <span class="hd-wave hd-grow" aria-hidden="true">
          {BARS.map((height, index) => (
            <span key={index} style={{ blockSize: `${height}px` }} />
          ))}
        </span>
        <span
          class="hd-mono"
          role="timer"
          aria-label={t('voice.timer', {
            elapsed: formatDuration(elapsed),
            max: formatDuration(maxSeconds),
          })}
        >
          {formatDuration(elapsed)}
        </span>
      </div>
      <button ref={stopButton} type="submit" class="hd-send" aria-label={t('voice.stop')}>
        <Icon name="send" />
      </button>
    </form>
  );
}
