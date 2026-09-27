import { useEffect, useRef, useState } from 'preact/hooks';
import { formatDuration } from '../format.js';
import { formatBytes } from '../state/policy.js';
import type { Attachment } from '../transport/types.js';
import { useWidget } from './context.js';
import { Icon } from './icons.js';

/**
 * Attachments inside a bubble (`WidgetStatesEN` column 3). Their URLs are
 * short-lived and issued only after the server authorises the visitor
 * (D §4.5), so each is fetched when the visitor asks for it, never up front.
 * A pending attachment has no conversation yet and is drawn inert.
 */
export function AttachmentView({
  attachment,
  conversationId,
}: {
  attachment: Attachment;
  conversationId: string | null;
}) {
  const { controller, t } = useWidget();
  const open = async () => {
    if (!conversationId) {
      return;
    }
    const url = await controller.transport.attachmentUrl(conversationId, attachment.id);
    window.open(url, '_blank', 'noopener');
  };

  if (attachment.kind === 'voice') {
    return <VoiceNote attachment={attachment} conversationId={conversationId} />;
  }

  if (attachment.kind === 'image' || attachment.kind === 'video') {
    const label = t(attachment.kind === 'image' ? 'attachment.openImage' : 'attachment.openVideo', {
      name: attachment.name,
    });
    const content = (
      <>
        <Icon name={attachment.kind} size={24} />
        <bdi>{attachment.name}</bdi>
      </>
    );
    return conversationId ? (
      <button type="button" class="hd-tile" aria-label={label} onClick={open}>
        {content}
      </button>
    ) : (
      <span class="hd-tile">{content}</span>
    );
  }

  const extension = attachment.name.includes('.')
    ? (attachment.name.split('.').pop() ?? '').toUpperCase()
    : '';
  return (
    <div class="hd-file">
      <Icon name="fileText" />
      <span class="hd-file-text">
        <bdi class="hd-file-name">{attachment.name}</bdi>
        <span class="hd-caption" dir="ltr">
          {extension ? `${extension} · ` : ''}
          {formatBytes(attachment.size_bytes)}
        </span>
      </span>
      {conversationId ? (
        <button
          type="button"
          class="hd-icon-button"
          aria-label={t('attachment.download', { name: attachment.name })}
          onClick={open}
        >
          <Icon name="download" />
        </button>
      ) : null}
    </div>
  );
}

const WAVE = [8, 14, 20, 12, 18, 24, 16, 8, 20, 14, 8, 12, 18, 8, 4];

function VoiceNote({
  attachment,
  conversationId,
}: {
  attachment: Attachment;
  conversationId: string | null;
}) {
  const { controller, t } = useWidget();
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const duration = formatDuration(attachment.duration_seconds ?? 0);

  useEffect(() => () => audio.current?.pause(), []);

  const toggle = async () => {
    if (!conversationId) {
      return;
    }
    if (playing) {
      audio.current?.pause();
      return;
    }
    if (!audio.current) {
      const element = new Audio(
        await controller.transport.attachmentUrl(conversationId, attachment.id),
      );
      element.onpause = () => setPlaying(false);
      element.onended = () => setPlaying(false);
      element.onplay = () => setPlaying(true);
      audio.current = element;
    }
    await audio.current.play().catch(() => setPlaying(false));
  };

  return (
    <div class="hd-voice">
      <button
        type="button"
        class="hd-voice-play"
        aria-label={t(playing ? 'voice.pause' : 'voice.play', { duration })}
        onClick={toggle}
        disabled={!conversationId}
      >
        <Icon name={playing ? 'pause' : 'play'} />
      </button>
      <span class="hd-wave" aria-hidden="true">
        {WAVE.map((height, index) => (
          <span key={index} style={{ blockSize: `${height}px` }} />
        ))}
      </span>
      <span class="hd-mono">{duration}</span>
    </div>
  );
}
