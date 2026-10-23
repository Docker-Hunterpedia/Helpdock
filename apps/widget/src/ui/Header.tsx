import { initials, nextOpening } from '../format.js';
import type { Translate } from '../i18n/translator.js';
import type { WidgetState } from '../state/controller.js';
import { closedUntil, teamHours } from '../state/hours.js';
import type { AgentSummary, ArticleSummary, WidgetLocale } from '../transport/types.js';
import { Avatar } from './Avatar.js';
import { useWidget, useWidgetState } from './context.js';
import { Icon } from './icons.js';

/**
 * Who the header names: the conversation's agent when it carries one, otherwise
 * whoever wrote the latest agent message (the live api does not put an agent on
 * the conversation, but every agent message names its author).
 */
const agentOf = (state: WidgetState): AgentSummary | null => {
  if (state.conversation?.agent) {
    return state.conversation.agent;
  }
  const last = state.thread.confirmed.findLast((message) => message.author.kind === 'agent');

  return last?.author.kind === 'agent' && last.author.agent.id !== 'brand'
    ? last.author.agent
    : null;
};

/** Title, caption and avatar for the header, from the "Header caption by state" note on `WidgetStatesEN`. */
export function headerContent(
  state: WidgetState,
  t: Translate,
  locale: WidgetLocale,
): { title: string; caption: string; avatar: string; avatarUrl: string | null } {
  const { config, conversation, availability } = state;
  const agent = agentOf(state);
  const brand = config?.brand.name ?? '';
  const team = t('header.chatTitle', { brand });
  const brandAvatar = initials(brand).slice(0, 1);

  if (config?.mode === 'form') {
    return {
      title: t('header.formTitle', { brand }),
      caption: t('header.caption.form'),
      avatar: brandAvatar,
      avatarUrl: null,
    };
  }
  if (config?.mode === 'helpcenter') {
    return {
      title: t('header.helpTitle', { brand }),
      caption: t('header.caption.help'),
      avatar: brandAvatar,
      avatarUrl: null,
    };
  }
  if (conversation?.status === 'ended') {
    return {
      title: team,
      caption: t('header.caption.ended'),
      avatar: brandAvatar,
      avatarUrl: null,
    };
  }
  if (agent) {
    const where = conversation?.department
      ? t('header.agentCaption', { department: conversation.department, team })
      : team;
    return {
      title: agent.name,
      // M14-12: the job title leads when the person has one.
      caption: agent.title ? `${agent.title} · ${where}` : where,
      avatar: initials(agent.name),
      avatarUrl: agent.avatar_url,
    };
  }
  if (conversation?.status === 'queued' && availability?.state === 'online') {
    return {
      title: team,
      caption: t('header.caption.queued'),
      avatar: brandAvatar,
      avatarUrl: null,
    };
  }
  // The hours of the team that answers: the same ones the handoff line reads (M7-06).
  const closure = closedUntil(teamHours(conversation, availability), new Date());
  if (closure?.next_open_at) {
    const { day, time } = nextOpening(closure.next_open_at, closure.timezone, locale);
    return {
      title: team,
      caption: t('header.caption.closed', { day, time }),
      avatar: brandAvatar,
      avatarUrl: null,
    };
  }
  if (availability?.state === 'open_offline') {
    return {
      title: team,
      caption: t('header.caption.openOffline'),
      avatar: brandAvatar,
      avatarUrl: null,
    };
  }
  return {
    title: team,
    caption: t('header.caption.online'),
    avatar: brandAvatar,
    avatarUrl: null,
  };
}

export function Header({
  article,
  onBack,
  onMinimise,
}: {
  article: ArticleSummary | null;
  onBack: () => void;
  onMinimise: () => void;
}) {
  const { t, locale } = useWidget();
  const state = useWidgetState();
  const content = headerContent(state, t, locale);
  const inHelpCenter = state.config?.mode === 'helpcenter';

  return (
    <header class={article ? 'hd-header hd-header-back' : 'hd-header'}>
      {article ? (
        <button
          type="button"
          class="hd-icon-button hd-on-accent"
          aria-label={t(inHelpCenter ? 'articles.back' : 'articles.backToChat')}
          onClick={onBack}
        >
          <Icon name="chevronStart" />
        </button>
      ) : (
        <Avatar
          name={content.title}
          url={content.avatarUrl}
          text={content.avatar}
          class="hd-header-avatar"
        />
      )}
      <div class="hd-header-text">
        <h2 id="hd-window-title">{article ? article.title : content.title}</h2>
        <span>{article ? (article.section ?? '') : content.caption}</span>
      </div>
      <button
        type="button"
        class="hd-icon-button hd-on-accent"
        aria-label={t('window.minimise')}
        onClick={onMinimise}
      >
        <Icon name="minus" />
      </button>
    </header>
  );
}
