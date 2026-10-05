import { useEffect, useRef, useState } from 'preact/hooks';
import { assistantAnswering } from '../state/thread.js';
import type { ArticleSummary } from '../transport/types.js';
import { TalkToHuman } from './Assistant.js';
import { Banners } from './Banners.js';
import { Composer } from './Composer.js';
import { ContactForm } from './ContactForm.js';
import { useLazy, useWidget, useWidgetState } from './context.js';
import { Ended } from './Ended.js';
import { usePhone, wrapFocus } from './focus-trap.js';
import { Header } from './Header.js';
import { Icon } from './icons.js';
import { loadArticle, loadHelpCenter } from './lazy.js';
import { PreChat } from './PreChat.js';
import { Thread } from './Thread.js';

const FOCUSABLE = 'input:not([type=hidden]):not([tabindex="-1"]), textarea, button, a[href]';

/**
 * The launcher and the window (DESIGN §6.6). Every mode keeps the same window,
 * header and footer; only the body changes (`WidgetModesEN`). The window is a
 * labelled region, not a modal: the host page stays usable behind it. On a
 * phone it fills the screen and covers the page, so there it is a modal
 * dialog that keeps Tab inside it, and the launcher steps aside (M9-04).
 */
export function App() {
  const { controller, t } = useWidget();
  const state = useWidgetState();
  const { config, open, unread } = state;
  const [article, setArticle] = useState<ArticleSummary | null>(null);
  const launcher = useRef<HTMLButtonElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(open);
  const phone = usePhone();

  const HelpCenter = useLazy(loadHelpCenter, open && config?.mode === 'helpcenter');
  const ArticleView = useLazy(loadArticle, article !== null);

  useEffect(() => {
    if (open && !wasOpen.current) {
      requestAnimationFrame(() => {
        const target =
          body.current?.querySelector<HTMLElement>('#hd-composer-input') ??
          body.current?.querySelector<HTMLElement>(FOCUSABLE);
        target?.focus();
      });
    }
    wasOpen.current = open;
  }, [open]);

  const closeArticle = () => {
    setArticle(null);
    requestAnimationFrame(() => body.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus());
  };

  if (!config) {
    return null;
  }

  const minimise = () => {
    controller.setOpen(false);
    // After the render: on a phone the launcher is hidden until the window closes.
    requestAnimationFrame(() => launcher.current?.focus());
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      minimise();
    } else if (phone) {
      wrapFocus(event.currentTarget as HTMLElement, event);
    }
  };

  const { launcher: launcherTheme } = config.theme;
  const launcherText = launcherTheme.label ?? t('launcher.text');
  const isChat = config.mode === 'chat' || config.mode === 'chat_articles';
  const conversation = state.conversation;
  const needsPreChat = isChat && !conversation && config.pre_chat.enabled;

  let content = null;
  if (article) {
    content = ArticleView ? <ArticleView article={article} /> : null;
  } else if (config.mode === 'form') {
    content = <ContactForm />;
  } else if (config.mode === 'helpcenter') {
    content = HelpCenter ? <HelpCenter onOpenArticle={setArticle} /> : null;
  } else if (needsPreChat) {
    content = <PreChat />;
  } else {
    content = (
      <>
        <Banners />
        <Thread onOpenArticle={setArticle} />
        {conversation?.status === 'ended' ? (
          <Ended />
        ) : (
          <>
            {assistantAnswering(state.thread, conversation?.ai_handed_off === true) ? (
              <TalkToHuman />
            ) : null}
            <Composer onOpenArticle={setArticle} />
          </>
        )}
      </>
    );
  }

  return (
    <div class={`hd-root hd-position-${launcherTheme.position}${open ? ' hd-root-open' : ''}`}>
      {open ? (
        <section
          class="hd-window"
          aria-label={t('window.label')}
          {...(phone ? { role: 'dialog', 'aria-modal': 'true' } : {})}
          onKeyDown={onKeyDown}
        >
          <Header article={article} onBack={closeArticle} onMinimise={minimise} />
          <div class="hd-content" ref={body}>
            {content}
          </div>
          {config.show_powered_by ? <div class="hd-powered">{t('window.poweredBy')}</div> : null}
        </section>
      ) : null}
      <button
        ref={launcher}
        type="button"
        class={`hd-launcher hd-launcher-${launcherTheme.style}`}
        aria-expanded={open}
        aria-label={
          open
            ? t('launcher.close')
            : unread > 0
              ? `${t('launcher.open')}, ${t('launcher.unread', { count: unread })}`
              : t('launcher.open')
        }
        onClick={() => (open ? minimise() : controller.setOpen(true))}
      >
        {launcherTheme.style === 'text' ? null : (
          <Icon name={open ? 'minus' : 'messageCircle'} size={24} />
        )}
        {launcherTheme.style === 'icon' ? null : <span aria-hidden="true">{launcherText}</span>}
        {!open && unread > 0 ? (
          <span class="hd-unread" aria-hidden="true">
            {unread > 9 ? '9+' : unread}
          </span>
        ) : null}
      </button>
    </div>
  );
}
