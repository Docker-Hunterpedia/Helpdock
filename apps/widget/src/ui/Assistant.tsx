import type { ComponentChildren } from 'preact';
import type { AiCitation, AiPart, ArticleSummary, WidgetMessage } from '../transport/types.js';
import { useWidget, useWidgetState } from './context.js';
import { Icon } from './icons.js';
import { Sentence } from './Sentence.js';

/**
 * The assistant in the thread (M7-06, `Widget/AI-EN`, `Widget/AI-AR`, DESIGN
 * §6.6 "AI answer"): the answer bubble named in words with the AIBadge, its
 * CitationList, "Was this helpful?", the handoff line and "Talk to a human".
 * A visitor never sees a confidence or a reason; a handoff is the brand's
 * text in the same bubble, then the line.
 */

export type OpenArticle = (article: ArticleSummary) => void;

const MARKER = /\[(\d+(?:,\s*\d+)*)\]/g;

const sourceId = (messageId: string, marker: number): string => `hd-source-${messageId}-${marker}`;

/** The answer's text with each `[n]` a link to its source in the list below. */
function CitedText({
  message,
  citations,
}: {
  message: WidgetMessage;
  citations: readonly AiCitation[];
}) {
  const { t } = useWidget();
  const parts: ComponentChildren[] = [];
  let last = 0;
  for (const match of message.body.matchAll(MARKER)) {
    const index = match.index;
    parts.push(message.body.slice(last, index));
    for (const number of (match[1] ?? '').split(',').map((value) => Number(value.trim()))) {
      const citation = citations.find((entry) => entry.marker === number);
      parts.push(
        citation === undefined ? (
          `[${number}]`
        ) : (
          <a
            key={`${index}-${number}`}
            class="hd-cite hd-mono"
            href={`#${sourceId(message.id, number)}`}
            aria-label={t('ai.source', { n: number, title: citation.title })}
            onClick={(event) => {
              event.preventDefault();
              const root = (event.currentTarget as HTMLElement).getRootNode() as ParentNode;
              root.querySelector<HTMLElement>(`#${sourceId(message.id, number)}`)?.focus();
            }}
          >
            [{number}]
          </a>
        ),
      );
    }
    last = index + match[0].length;
  }
  parts.push(message.body.slice(last));
  return <>{parts}</>;
}

function Sources({
  message,
  citations,
  onOpenArticle,
}: {
  message: WidgetMessage;
  citations: readonly AiCitation[];
  onOpenArticle: OpenArticle;
}) {
  const { t } = useWidget();
  const labelId = `hd-sources-${message.id}`;
  return (
    <div class="hd-sources">
      <div id={labelId} class="hd-caption">
        {t('ai.sources')}
      </div>
      <ol class="hd-source-list" aria-labelledby={labelId}>
        {citations.map((citation) => (
          <li key={citation.marker}>
            <a
              id={sourceId(message.id, citation.marker)}
              class="hd-source"
              href={citation.url ?? '#'}
              target="_blank"
              rel="noopener"
              onClick={(event) => {
                if (citation.article_id !== null) {
                  event.preventDefault();
                  onOpenArticle({
                    id: citation.article_id,
                    title: citation.title,
                    excerpt: '',
                    section: null,
                    url: citation.url,
                  });
                } else if (citation.url === null) {
                  event.preventDefault();
                }
              }}
            >
              <span class="hd-mono hd-source-number">{citation.marker}</span>
              <Icon name="book" size={16} />
              <span class="hd-grow">{citation.title}</span>
              <Icon name="chevronEnd" size={16} />
            </a>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Feedback({ message, ai }: { message: WidgetMessage; ai: AiPart }) {
  const { controller, t } = useWidget();
  if (ai.feedback !== null) {
    return (
      // No role of its own: the thread's log announces what is added to it, and a status inside a log is read twice.
      <div class="hd-ai-thanks">
        <Icon name="circleCheck" size={16} />
        {t('ai.thanks')}
      </div>
    );
  }
  return (
    <fieldset class="hd-ai-feedback" aria-label={t('ai.helpful')}>
      <span class="hd-grow" aria-hidden="true">
        {t('ai.helpful')}
      </span>
      <button
        type="button"
        class="hd-icon-button hd-icon-button-outlined"
        aria-label={t('ai.yes')}
        aria-pressed="false"
        onClick={() => controller.sendFeedback(message.id, 'helpful')}
      >
        <Icon name="thumbsUp" size={18} />
      </button>
      <button
        type="button"
        class="hd-icon-button hd-icon-button-outlined"
        aria-label={t('ai.no')}
        aria-pressed="false"
        onClick={() => controller.sendFeedback(message.id, 'not_helpful')}
      >
        <Icon name="thumbsDown" size={18} />
      </button>
    </fieldset>
  );
}

/** One assistant message: the answer with its sources and feedback, or the handoff text. */
export function AssistantMessage({
  message,
  onOpenArticle,
}: {
  message: WidgetMessage;
  onOpenArticle: OpenArticle;
}) {
  const { t } = useWidget();
  const { config } = useWidgetState();
  const ai = message.ai ?? { kind: 'answer', citations: [], feedback: null };
  const citations = ai.kind === 'answer' ? ai.citations : [];
  return (
    <li class="hd-row hd-row-agent hd-row-ai">
      <span class="hd-avatar hd-avatar-md hd-avatar-ai" aria-hidden="true">
        <Icon name="sparkles" size={14} />
      </span>
      <div class="hd-stack">
        <span class="hd-author hd-author-ai">
          {t('ai.author', { brand: config?.brand.name ?? '' })}
          <span class="hd-ai-badge">
            <Icon name="sparkles" size={14} />
            {t('ai.badge')}
          </span>
        </span>
        <div class="hd-bubble hd-bubble-agent hd-bubble-ai">
          <CitedText message={message} citations={citations} />
          {citations.length > 0 ? (
            <Sources message={message} citations={citations} onOpenArticle={onOpenArticle} />
          ) : null}
        </div>
        {ai.kind === 'answer' ? <Feedback message={message} ai={ai} /> : null}
      </div>
    </li>
  );
}

/** The handoff line (DESIGN §6.6): who answers now, and where. A log entry, so it is read once. */
export function HandoffLine() {
  const { t } = useWidget();
  const { visitorEmail } = useWidgetState();
  return (
    <li class="hd-system hd-handoff">
      <Icon name="headset" size={16} />
      <span>
        <strong class="hd-handoff-title">{t('ai.connecting')}</strong>
        <br />
        {visitorEmail ? (
          <Sentence id="ai.steppedBackEmail" vars={{ email: visitorEmail }} isolate={['email']} />
        ) : (
          t('ai.steppedBack')
        )}
      </span>
    </li>
  );
}

/** Above the composer while the assistant is answering; gone for good once handed off. */
export function TalkToHuman() {
  const { controller, t } = useWidget();
  return (
    <div class="hd-talk">
      <button
        type="button"
        class="hd-button hd-button-accent-outline hd-button-block"
        onClick={() => void controller.handOff()}
      >
        <Icon name="headset" size={18} />
        {t('ai.talkToHuman')}
      </button>
    </div>
  );
}
