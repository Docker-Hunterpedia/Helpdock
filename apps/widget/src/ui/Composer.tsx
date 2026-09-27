import { useRef, useState } from 'preact/hooks';
import { acceptList, canAttach } from '../state/policy.js';
import type { ArticleSummary } from '../transport/types.js';
import { useLazy, useWidget, useWidgetState } from './context.js';
import { Icon } from './icons.js';
import { loadRecorder } from './lazy.js';

const SUGGESTIONS = 3;

export const canRecord = (): boolean =>
  typeof MediaRecorder !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia);

/**
 * DESIGN §6.6 Composer: attach, a 44 px pill input, voice, send. In
 * `chat_articles` mode the suggestion strip appears above it once the visitor
 * types (`WidgetModesEN` column 2; popular articles until M7).
 */
export function Composer({ onOpenArticle }: { onOpenArticle: (article: ArticleSummary) => void }) {
  const { controller, t } = useWidget();
  const { config, attachmentProblem } = useWidgetState();
  const [text, setText] = useState('');
  const [recording, setRecording] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const Recorder = useLazy(loadRecorder, recording);

  if (!config) {
    return null;
  }
  const policy = config.content_policy;
  const showVoice = policy.voice.enabled && canRecord();
  const suggestions =
    config.mode === 'chat_articles' && text.trim()
      ? config.popular_articles.slice(0, SUGGESTIONS)
      : [];

  const submit = (event: Event) => {
    event.preventDefault();
    controller.send(text);
    setText('');
  };

  const pick = (event: Event) => {
    const target = event.currentTarget as HTMLInputElement;
    controller.sendFiles([...(target.files ?? [])]);
    target.value = '';
  };

  const stopRecording = () => {
    setRecording(false);
    requestAnimationFrame(() => input.current?.focus());
  };

  return (
    <>
      {attachmentProblem ? (
        <div class="hd-alert hd-alert-danger hd-composer-alert" role="alert">
          <Icon name="alert" size={16} />
          <span>{t(attachmentProblem.key, attachmentProblem.vars)}</span>
          <button
            type="button"
            class="hd-icon-button"
            aria-label={t('attachment.dismiss')}
            onClick={() => controller.dismissAttachmentProblem()}
          >
            <Icon name="x" size={16} />
          </button>
        </div>
      ) : null}
      {suggestions.length > 0 ? (
        <nav class="hd-suggestions" aria-labelledby="hd-suggestions-title">
          <div id="hd-suggestions-title" class="hd-caption">
            {t('articles.suggested')}
          </div>
          {suggestions.map((article) => (
            <a
              key={article.id}
              class="hd-suggestion"
              href={article.url}
              target="_blank"
              rel="noopener"
              onClick={(event) => {
                if (!(event.metaKey || event.ctrlKey || event.shiftKey)) {
                  event.preventDefault();
                  onOpenArticle(article);
                }
              }}
            >
              <Icon name="book" size={16} />
              <span class="hd-grow">{article.title}</span>
              <Icon name="chevronEnd" size={16} />
            </a>
          ))}
        </nav>
      ) : null}
      {recording && Recorder ? (
        <Recorder
          maxSeconds={policy.voice.max_seconds}
          t={t}
          onCancel={stopRecording}
          onDone={(blob, name) => {
            stopRecording();
            controller.sendVoice(blob, name);
          }}
        />
      ) : (
        <form class="hd-composer" onSubmit={submit}>
          {canAttach(policy) ? (
            <>
              <button
                type="button"
                class="hd-icon-button"
                aria-label={t('composer.attach')}
                onClick={() => picker.current?.click()}
              >
                <Icon name="paperclip" />
              </button>
              <input
                ref={picker}
                type="file"
                class="hd-hidden"
                tabIndex={-1}
                aria-hidden="true"
                multiple={policy.max_attachments_per_message > 1}
                accept={acceptList(policy)}
                onChange={pick}
              />
            </>
          ) : null}
          <label for="hd-composer-input" class="hd-visually-hidden">
            {t('composer.label')}
          </label>
          <input
            id="hd-composer-input"
            ref={input}
            class="hd-pill-input"
            type="text"
            autocomplete="off"
            placeholder={t('composer.placeholder')}
            value={text}
            onInput={(event) => {
              setText(event.currentTarget.value);
              controller.visitorTyping();
            }}
          />
          {showVoice ? (
            <button
              type="button"
              class="hd-icon-button"
              aria-label={t('composer.voice')}
              onClick={() => setRecording(true)}
            >
              <Icon name="mic" />
            </button>
          ) : null}
          <button type="submit" class="hd-send" aria-label={t('composer.send')}>
            <Icon name="send" />
          </button>
        </form>
      )}
    </>
  );
}
