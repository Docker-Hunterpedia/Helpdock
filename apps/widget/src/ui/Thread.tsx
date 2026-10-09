import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { dayLabel, formatTime, initials } from '../format.js';
import { closedUntil, teamHours } from '../state/hours.js';
import { deliveryOf, type PendingMessage } from '../state/thread.js';
import type { AgentSummary, WidgetMessage } from '../transport/types.js';
import { AssistantMessage, HandoffLine, type OpenArticle } from './Assistant.js';
import { AttachmentView } from './Attachments.js';
import { CsatCard } from './CsatCard.js';
import { useWidget, useWidgetState } from './context.js';
import { Icon } from './icons.js';

/**
 * The thread (`WidgetStatesEN` columns 2–6): an `<ol>` inside a `role="log"`
 * region with `aria-live="polite"` that can take focus so it scrolls by
 * keyboard (M4-11).
 * Typing, queue position and connection banners live outside it: they are
 * ephemeral and must not be read out as messages.
 */
export function Thread({ onOpenArticle }: { onOpenArticle: OpenArticle }) {
  const { t, locale } = useWidget();
  const state = useWidgetState();
  const {
    config,
    thread,
    conversation,
    reconnected,
    firstMessageNotice,
    visitorEmail,
    typing,
    csat,
    availability,
  } = state;
  const scroller = useRef<HTMLDivElement>(null);
  const count = thread.confirmed.length + thread.pending.length;
  const hours = teamHours(conversation, availability);
  useWakeAt(hours?.next_open_at ?? null);

  useEffect(() => {
    const element = scroller.current;
    if (element) {
      element.scrollTop = element.scrollHeight;
    }
  }, [count, typing, csat]);

  if (!config) {
    return null;
  }

  const team = t('header.chatTitle', { brand: config.brand.name });
  const now = new Date();
  const items: ComponentChildren[] = [];
  let lastDay = '';
  let noticeShown = false;

  const addDay = (iso: string) => {
    const day = dayLabel(iso, now, locale, t);
    if (day !== lastDay) {
      lastDay = day;
      items.push(
        <li key={`day-${iso}`} class="hd-day">
          {day}
        </li>,
      );
    }
  };

  const addNotice = () => {
    if (noticeShown || !firstMessageNotice || !visitorEmail) {
      return;
    }
    noticeShown = true;
    items.push(
      <li key="notice" class="hd-system">
        {firstMessageNotice === 'closed'
          ? t('thread.replyAfterOpening', { email: visitorEmail })
          : t('thread.talkingTo', { team, email: visitorEmail })}
      </li>,
    );
  };

  if (config.greeting) {
    addDay(thread.confirmed[0]?.created_at ?? thread.pending[0]?.created_at ?? now.toISOString());
    items.push(
      <li key="greeting" class="hd-row hd-row-agent">
        <AgentBubble name={config.brand.name}>
          <div class="hd-bubble hd-bubble-agent">{config.greeting}</div>
        </AgentBubble>
      </li>,
    );
  }

  const handoffBefore = handoffPosition(thread.confirmed, conversation?.ai_handed_off === true);
  // The line says the team is away only while that is true: not once a person
  // has answered after the handoff, and not past the opening.
  const awaitingTeam =
    handoffBefore >= 0 &&
    !thread.confirmed.slice(handoffBefore).some((message) => message.author.kind === 'agent');
  const closure = awaitingTeam ? closedUntil(hours, now) : null;
  // A new key replaces the <li>, so the log announces the new wording.
  const handoffLine = <HandoffLine key={closure ? 'handoff-away' : 'handoff'} closure={closure} />;

  thread.confirmed.forEach((message, index) => {
    if (index === handoffBefore) {
      items.push(handoffLine);
    }
    addDay(message.created_at);
    if (reconnected && reconnected.firstNewSeq === message.seq && reconnected.newCount > 0) {
      items.push(
        <li key="new" class="hd-divider">
          <span aria-hidden="true" />
          {t('connection.newMessages', { count: reconnected.newCount })}
          <span aria-hidden="true" />
        </li>,
      );
    }
    items.push(
      message.author.kind === 'ai' ? (
        <AssistantMessage key={message.seq} message={message} onOpenArticle={onOpenArticle} />
      ) : (
        <MessageItem
          key={message.seq}
          message={message}
          conversationId={conversation?.id ?? null}
        />
      ),
    );
    if (message.author.kind === 'visitor') {
      addNotice();
    }
  });
  if (handoffBefore === thread.confirmed.length) {
    items.push(handoffLine);
  }

  for (const pending of thread.pending) {
    addDay(pending.created_at);
    items.push(<PendingItem key={pending.client_id} pending={pending} />);
    addNotice();
  }

  if (conversation?.status === 'ended' && csat) {
    items.push(<CsatCard key="csat" card={csat} />);
  }

  return (
    <div class="hd-thread" ref={scroller}>
      {/* The log role is on a wrapper: on the <ol> itself it would drop the list semantics. */}
      <div
        class="hd-log"
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        aria-label={t('thread.label')}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the log scrolls, so it must take focus (M4-11)
        tabIndex={0}
      >
        <ol class="hd-log-list">{items}</ol>
      </div>
      {typing ? <Typing agent={typing} /> : null}
    </div>
  );
}

/** The longest delay a browser keeps; a longer one fires at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * Renders the caller again a second after `iso`, so a line worded "closed
 * until" is judged again at the opening. A wait longer than a timer can hold
 * ends early and arms itself again on the render it causes.
 */
function useWakeAt(iso: string | null): void {
  const [woken, wake] = useState(0);
  useEffect(() => {
    const delay = iso === null ? 0 : new Date(iso).getTime() + 1_000 - Date.now();
    if (delay <= 0) {
      return;
    }
    const timer = setTimeout(() => wake(woken + 1), Math.min(delay, MAX_TIMER_MS));
    return () => clearTimeout(timer);
  }, [iso, woken]);
}

/**
 * Where the handoff line goes (M7-06): after the assistant's handoff message;
 * otherwise before the first person to answer after the assistant last
 * spoke, or at the end while nobody has. `-1` while the assistant has the
 * conversation.
 */
export const handoffPosition = (messages: readonly WidgetMessage[], handedOff: boolean): number => {
  if (!handedOff) {
    return -1;
  }
  const lastAi = messages.findLastIndex((message) => message.author.kind === 'ai');
  if (lastAi >= 0 && messages[lastAi]?.ai?.kind === 'handoff') {
    return lastAi + 1;
  }
  const agent = messages.findIndex(
    (message, index) => index > lastAi && message.author.kind === 'agent',
  );
  return agent >= 0 ? agent : messages.length;
};

function Avatar({ name, size }: { name: string; size: 'sm' | 'md' }) {
  return (
    <span class={`hd-avatar hd-avatar-${size}`} aria-hidden="true">
      {initials(name)}
    </span>
  );
}

function AgentBubble({ name, children }: { name: string; children: ComponentChildren }) {
  return (
    <>
      <Avatar name={name} size="md" />
      <div class="hd-stack">
        <span class="hd-author">{name}</span>
        {children}
      </div>
    </>
  );
}

function MessageItem({
  message,
  conversationId,
}: {
  message: WidgetMessage;
  conversationId: string | null;
}) {
  const { t, locale } = useWidget();
  const { thread } = useWidgetState();
  const time = formatTime(message.created_at, locale);

  if (message.author.kind === 'system') {
    const { system } = message;
    const text =
      system?.code === 'agent_joined'
        ? t('thread.agentJoined', { name: system.name ?? '' })
        : system?.name
          ? t('thread.ended', { name: system.name })
          : t('thread.endedAnonymous');
    return (
      <li class="hd-system">
        {text} · <span class="hd-mono">{time}</span>
      </li>
    );
  }

  const content = (
    <>
      {message.body ? (
        <div
          class={`hd-bubble ${message.author.kind === 'visitor' ? 'hd-bubble-visitor' : 'hd-bubble-agent'}`}
        >
          {message.body}
        </div>
      ) : null}
      {message.attachments.map((attachment) => (
        <AttachmentView
          key={attachment.id}
          attachment={attachment}
          conversationId={conversationId}
        />
      ))}
    </>
  );

  if (message.author.kind === 'agent') {
    return (
      <li class="hd-row hd-row-agent">
        <AgentBubble name={message.author.agent.name}>{content}</AgentBubble>
      </li>
    );
  }

  const seen = deliveryOf(thread, message) === 'seen';
  return (
    <li class="hd-row hd-row-visitor">
      {content}
      <div class="hd-meta">
        <span class="hd-mono">{time}</span>
        {' · '}
        <Icon name={seen ? 'checkCheck' : 'check'} size={14} />
        {t(seen ? 'message.seen' : 'message.sent')}
      </div>
    </li>
  );
}

function PendingItem({ pending }: { pending: PendingMessage }) {
  const { controller, t } = useWidget();
  const failed = pending.status === 'failed';
  const bubbleId = `hd-pending-${pending.client_id}`;
  const statusId = `hd-pending-status-${pending.client_id}`;

  return (
    <li class="hd-row hd-row-visitor">
      {pending.body ? (
        <div id={bubbleId} class={`hd-bubble ${failed ? 'hd-bubble-failed' : 'hd-bubble-visitor'}`}>
          {pending.body}
        </div>
      ) : null}
      {pending.attachments.map((attachment) => (
        <AttachmentView key={attachment.id} attachment={attachment} conversationId={null} />
      ))}
      {failed ? (
        <div class="hd-meta">
          <span id={statusId} class="hd-not-sent">
            <Icon name="alert" size={14} />
            {t('message.notSent')}
          </span>
          <button
            type="button"
            class="hd-button hd-button-secondary hd-button-small"
            aria-describedby={pending.body ? `${bubbleId} ${statusId}` : statusId}
            onClick={() => controller.retry(pending.client_id)}
          >
            <Icon name="retry" size={16} />
            {t('message.retry')}
          </button>
        </div>
      ) : (
        <div class="hd-meta">
          <Icon name="clock" size={14} />
          {t('message.sending')}
        </div>
      )}
    </li>
  );
}

function Typing({ agent }: { agent: AgentSummary }) {
  const { t } = useWidget();
  return (
    <div class="hd-typing">
      <Avatar name={agent.name} size="sm" />
      <span class="hd-typing-dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span class="hd-caption">
        {t('thread.typing', { name: agent.name.split(' ')[0] ?? agent.name })}
      </span>
    </div>
  );
}
