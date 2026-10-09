import { useEffect } from 'preact/hooks';
import { initials, listNames, nextOpening, ordinal } from '../format.js';
import { closedUntil, teamHours } from '../state/hours.js';
import { useWidget, useWidgetState } from './context.js';
import { Icon } from './icons.js';

const BACK_ONLINE_MS = 5_000;

/**
 * The strips between the header and the thread: presence (`WidgetModesEN`
 * column 1), queue position (`WidgetStatesEN` column 2), out of hours
 * (column 4) and the connection banners (column 5). Only one shows at a time,
 * the most urgent first.
 */
export function Banners() {
  const { controller, t, locale } = useWidget();
  const { availability, conversation, queue, connection, reconnected } = useWidgetState();

  useEffect(() => {
    if (!reconnected) {
      return;
    }
    const timer = setTimeout(() => controller.clearReconnected(), BACK_ONLINE_MS);
    return () => clearTimeout(timer);
  }, [reconnected, controller]);

  if (connection === 'reconnecting') {
    return (
      <div class="hd-banner hd-banner-warning" role="status">
        <Icon name="wifiOff" size={16} />
        <span>
          <strong>{t('connection.reconnectingTitle')}</strong>
          {t('connection.reconnectingBody')}
        </span>
      </div>
    );
  }

  if (reconnected) {
    return (
      <div class="hd-banner hd-banner-success" role="status">
        <Icon name="circleCheck" size={16} />
        <span>{t('connection.back')}</span>
      </div>
    );
  }

  if (conversation?.status === 'queued' && queue) {
    const position = t('queue.position', { position: ordinal(queue.position, locale, t) });
    const minutes =
      queue.eta_seconds === null ? null : Math.max(1, Math.round(queue.eta_seconds / 60));
    return (
      <div class="hd-banner hd-banner-muted" role="status">
        <Icon name="users" size={16} />
        <span>
          {minutes === null ? position : `${position} · ${t('queue.eta', { count: minutes })}`}
        </span>
      </div>
    );
  }

  const closure = closedUntil(teamHours(conversation, availability), new Date());
  if (closure?.next_open_at && conversation?.status !== 'ended') {
    const opening = nextOpening(closure.next_open_at, closure.timezone, locale);
    return (
      <div class="hd-banner hd-banner-muted" role="status">
        <Icon name="moon" size={16} />
        <span>
          <strong>{t('hours.closedTitle')}</strong>
          {t('hours.closedBody', opening)}
        </span>
      </div>
    );
  }

  const online = availability?.state === 'online' ? availability.agents_online : [];
  if (!conversation && online.length > 0) {
    const names = online.map((agent) => agent.name.split(' ')[0] ?? agent.name);
    return (
      <div class="hd-presence">
        <span class="hd-avatar-stack" aria-hidden="true">
          {online.slice(0, 3).map((agent) => (
            <span key={agent.id} class="hd-avatar hd-avatar-sm">
              {initials(agent.name)}
            </span>
          ))}
        </span>
        <span>
          {t(names.length === 1 ? 'presence.single' : 'presence.several', {
            names: listNames(names, locale),
          })}
        </span>
      </div>
    );
  }

  return null;
}
