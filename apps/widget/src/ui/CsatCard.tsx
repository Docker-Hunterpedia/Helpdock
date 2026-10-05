import { useState } from 'preact/hooks';
import { formatTime } from '../format.js';
import type { CsatCard as Card } from '../transport/types.js';
import { useWidget } from './context.js';
import { Icon } from './icons.js';

/**
 * The satisfaction card after "ended the conversation" (M8-06, `Widget/CSAT-EN`,
 * `Widget/CSAT-AR`; DESIGN §6.6). It is a list item of the log, so a screen
 * reader meets it in order.
 *
 * - **Open**: five 44 px toggle buttons in a fieldset with a hidden legend,
 *   the number in mono over an `aria-hidden` caption pair, an optional
 *   comment, Skip and "Send rating" (enabled once a number is pressed). Esc
 *   does not dismiss it; Skip does.
 * - **Rated**: a `role="status"` success box echoing the score and comment.
 * - **Skipped**: a system line with the time. Nothing was recorded.
 * - **Expired**: a `role="note"` box; ratings stay open thirty days.
 */

const SCORES = [1, 2, 3, 4, 5] as const;
/** `Widget/CSAT-EN`: the comment is capped at 1000 characters (`WIDGET_CSAT_COMMENT_MAX`). */
const COMMENT_MAX = 1000;

export function CsatCard({ card }: { card: Card }) {
  const { t, locale } = useWidget();

  if (card.state === 'open') {
    return <CsatForm />;
  }

  const skipped = card.skipped_at ? (
    <li class="hd-system">
      {t('csat.skipped')} · <span class="hd-mono">{formatTime(card.skipped_at, locale)}</span>
    </li>
  ) : null;

  if (card.state === 'rated') {
    const rating = card.rating ?? 0;
    return (
      <li class="hd-csat">
        <div class="hd-alert hd-alert-success hd-csat-box" role="status">
          <Icon name="circleCheck" size={16} />
          <div class="hd-stack">
            <strong>{t('csat.thanks')}</strong>
            <span>{t('csat.rated', { rating, label: t(`csat.ratings.${String(rating)}`) })}</span>
            {card.comment ? <span>“{card.comment}”</span> : null}
          </div>
        </div>
      </li>
    );
  }

  if (card.state === 'skipped') {
    return skipped;
  }

  return (
    <>
      {skipped}
      <li class="hd-csat">
        <div class="hd-note hd-csat-box" role="note">
          <Icon name="clock" size={16} />
          <div class="hd-stack">
            <strong>{t('csat.closedTitle')}</strong>
            <span>{t('csat.closedBody')}</span>
          </div>
        </div>
      </li>
    </>
  );
}

function CsatForm() {
  const { controller, t } = useWidget();
  const [rating, setRating] = useState<number | null>(null);
  const [comment, setComment] = useState('');
  const [status, setStatus] = useState<'idle' | 'busy' | 'failed'>('idle');

  const act = async (action: () => Promise<void>) => {
    setStatus('busy');
    try {
      await action();
    } catch {
      setStatus('failed');
    }
  };

  const submit = (event: Event) => {
    event.preventDefault();
    if (rating !== null) {
      void act(() => controller.rateConversation(rating, comment));
    }
  };

  return (
    <li class="hd-csat">
      <form class="hd-csat-card" aria-labelledby="hd-csat-question" onSubmit={submit}>
        <h3 id="hd-csat-question" class="hd-h3">
          {t('csat.question')}
        </h3>
        <fieldset class="hd-csat-scale">
          <legend class="hd-visually-hidden">{t('csat.legend')}</legend>
          <div class="hd-csat-scores">
            {SCORES.map((score) => (
              <button
                key={score}
                type="button"
                class="hd-csat-score"
                aria-pressed={rating === score}
                aria-label={t('csat.choice', {
                  rating: score,
                  label: t(`csat.ratings.${String(score)}`),
                })}
                onClick={() => setRating(score)}
              >
                {score}
              </button>
            ))}
          </div>
          <div class="hd-csat-ends" aria-hidden="true">
            <span>{t('csat.low')}</span>
            <span>{t('csat.high')}</span>
          </div>
        </fieldset>
        <div class="hd-field">
          <label for="hd-csat-comment">
            {t('csat.comment')} <span class="hd-optional">{t('csat.optional')}</span>
          </label>
          <textarea
            id="hd-csat-comment"
            class="hd-input hd-textarea"
            rows={2}
            maxLength={COMMENT_MAX}
            value={comment}
            onInput={(event) => setComment(event.currentTarget.value)}
          />
        </div>
        {status === 'failed' ? (
          <p class="hd-field-error" role="alert">
            <Icon name="alert" size={14} />
            {t('csat.failed')}
          </p>
        ) : null}
        <div class="hd-csat-actions">
          <button
            type="button"
            class="hd-button hd-button-ghost"
            disabled={status === 'busy'}
            onClick={() => void act(() => controller.skipCsat())}
          >
            {t('csat.skip')}
          </button>
          <button
            type="submit"
            class="hd-button hd-button-primary hd-grow"
            disabled={rating === null || status === 'busy'}
          >
            {t('csat.send')}
          </button>
        </div>
      </form>
    </li>
  );
}
