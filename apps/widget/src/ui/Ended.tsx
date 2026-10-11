import { useState } from 'preact/hooks';
import { useWidget, useWidgetState } from './context.js';
import { EMAIL_PATTERN } from './Field.js';
import { Icon } from './icons.js';
import { Sentence } from './Sentence.js';

/**
 * `WidgetStatesEN` column 6 (M4-08): the conversation has ended. The
 * transcript form appears only when the brand turns transcripts on; it is
 * prefilled from the pre-chat email and sends only this conversation, with no
 * links that grant access (D §4.1).
 */
export function Ended() {
  const { controller, t } = useWidget();
  const { config, visitorEmail } = useWidgetState();
  const [email, setEmail] = useState(visitorEmail ?? '');
  const [status, setStatus] = useState<'idle' | 'busy' | 'sent' | 'invalid' | 'failed'>('idle');
  const [sentTo, setSentTo] = useState('');

  const submit = async (event: Event) => {
    event.preventDefault();
    const address = email.trim();
    if (!EMAIL_PATTERN.test(address)) {
      setStatus('invalid');
      return;
    }
    setStatus('busy');
    try {
      await controller.requestTranscript(address);
      setSentTo(address);
      setStatus('sent');
    } catch {
      setStatus('failed');
    }
  };

  const problem =
    status === 'invalid'
      ? t('prechat.invalidEmail')
      : status === 'failed'
        ? t('ended.failed')
        : null;

  return (
    <div class="hd-ended">
      <h3 class="hd-h3">{t('ended.title')}</h3>
      {config?.transcript_enabled ? (
        status === 'sent' ? (
          <p class="hd-alert hd-alert-success" role="status">
            <Icon name="circleCheck" size={16} />
            <span>
              <Sentence id="ended.sent" vars={{ email: sentTo }} isolate={['email']} />
            </span>
          </p>
        ) : (
          <form class="hd-field" onSubmit={submit} noValidate>
            <label for="hd-transcript-email">{t('ended.transcriptLabel')}</label>
            <div class="hd-inline">
              <input
                id="hd-transcript-email"
                class="hd-input hd-grow"
                type="email"
                dir="ltr"
                autocomplete="email"
                value={email}
                aria-invalid={problem ? true : undefined}
                aria-describedby={problem ? 'hd-transcript-error' : 'hd-transcript-hint'}
                onInput={(event) => setEmail(event.currentTarget.value)}
              />
              <button
                type="submit"
                class="hd-button hd-button-secondary"
                disabled={status === 'busy'}
              >
                <Icon name="send" size={16} />
                {t('ended.send')}
              </button>
            </div>
            {problem ? (
              <p id="hd-transcript-error" class="hd-field-error" role="alert">
                <Icon name="alert" size={14} />
                {problem}
              </p>
            ) : (
              <p id="hd-transcript-hint" class="hd-hint">
                {t('ended.transcriptHint')}
              </p>
            )}
          </form>
        )
      ) : null}
      <button
        type="button"
        class="hd-button hd-button-primary hd-button-block"
        onClick={() => void controller.newConversation()}
      >
        {t('ended.newConversation')}
      </button>
    </div>
  );
}
