import type { Locale } from '@helpdock/i18n';
import type { NotificationView } from '@helpdock/schemas';
import type { useT } from '../app/i18n.js';

/**
 * How one row of the bell's panel reads (artboard `AdminNotifications`):
 * a title that says what happened, a line with the ticket, and a caption with
 * where and when. Pure, so every kind is provable without a screen.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

type T = ReturnType<typeof useT>;

export const timeAgo = (t: T, iso: string, now: number): string => {
  const elapsed = Math.max(0, now - Date.parse(iso));
  if (elapsed < MINUTE) {
    return t('admin:notifications.ago.now');
  }
  if (elapsed < HOUR) {
    return t('admin:notifications.ago.minutes', { count: Math.floor(elapsed / MINUTE) });
  }
  if (elapsed < DAY) {
    return t('admin:notifications.ago.hours', { count: Math.floor(elapsed / HOUR) });
  }

  return t('admin:notifications.ago.days', { count: Math.floor(elapsed / DAY) });
};

const clockOf = (t: T, item: NotificationView): string =>
  t(`admin:notifications.clock.${item.detail.clock ?? 'unknown'}`);

export const notificationTitle = (t: T, item: NotificationView): string => {
  const actor = item.actorName ?? t('admin:notifications.someone');

  switch (item.kind) {
    case 'assigned':
      return t(`admin:notifications.title.assigned.${item.detail.assignedBy ?? 'person'}`, {
        actor,
      });
    case 'mentioned':
      return t('admin:notifications.title.mentioned', { actor });
    case 'sla_warning':
    case 'sla_breached':
      return t(`admin:notifications.title.${item.kind}`, { clock: clockOf(t, item) });
    case 'replied':
    case 'escalated':
      return t(`admin:notifications.title.${item.kind}`);
  }
};

/**
 * What follows the reference on the second line: the note's words for a
 * mention, a rule's own message, how much of the target is used for a
 * warning, the subject for the rest.
 */
export const notificationLine = (t: T, item: NotificationView): string => {
  if (item.kind === 'mentioned' && item.excerpt !== null) {
    return `“${item.excerpt}”`;
  }
  if (item.kind === 'escalated' && item.detail.message !== undefined) {
    return `“${item.detail.message}”`;
  }
  if (item.kind === 'sla_warning' && item.detail.stepPercent !== undefined) {
    return t('admin:notifications.warningLine', { percent: item.detail.stepPercent });
  }

  return item.subject;
};

export const notificationCaption = (
  t: T,
  item: NotificationView,
  locale: Locale,
  now: number,
): string => {
  const time = timeAgo(t, item.createdAt, now);

  if (item.kind === 'mentioned') {
    return t('admin:notifications.caption.note', { time });
  }
  if (item.kind === 'replied' && item.messageChannel !== null) {
    return t('admin:notifications.caption.channel', {
      channel: t(`tickets:channel.${item.messageChannel}`),
      time,
    });
  }
  if (item.kind === 'escalated' && item.detail.stepPercent !== undefined) {
    return t('admin:notifications.caption.department', {
      department: t('admin:notifications.escalatedLine', { percent: item.detail.stepPercent }),
      time,
    });
  }
  if (item.kind === 'assigned') {
    const department =
      locale === 'ar' ? (item.departmentNameAr ?? item.departmentName) : item.departmentName;
    return t('admin:notifications.caption.department', { department, time });
  }

  return t('admin:notifications.caption.time', { time });
};

export type DayGroup = 'today' | 'yesterday' | 'earlier';

/** Which heading a row sits under, by the reader's own calendar day. */
export const dayGroup = (iso: string, now: number): DayGroup => {
  const at = new Date(iso);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);

  if (at.getTime() >= today.getTime()) {
    return 'today';
  }

  return at.getTime() >= today.getTime() - DAY ? 'yesterday' : 'earlier';
};

/** Rows grouped under their headings, in the order they arrived. */
export const groupByDay = (
  items: readonly NotificationView[],
  now: number,
): { readonly group: DayGroup; readonly items: readonly NotificationView[] }[] => {
  const groups: { group: DayGroup; items: NotificationView[] }[] = [];
  for (const item of items) {
    const group = dayGroup(item.createdAt, now);
    const last = groups.at(-1);
    if (last?.group === group) {
      last.items.push(item);
    } else {
      groups.push({ group, items: [item] });
    }
  }

  return groups;
};
