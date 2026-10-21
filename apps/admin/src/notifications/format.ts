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
    case 'snooze_ended':
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

// ------------------------------------------------------------------ bulk edits

/** A row of the panel: one notification, or one bulk edit's assignments folded into a line. */
export type PanelEntry =
  | { readonly type: 'item'; readonly item: NotificationView }
  | {
      readonly type: 'bulk';
      readonly operationId: string;
      /** Newest first, as the panel lists them. */
      readonly items: readonly NotificationView[];
    };

/** An operation that assigned fewer tickets than this is not worth a line of its own. */
export const BULK_FOLD_MIN = 2;

/**
 * Folds the `assigned` rows one bulk edit made into one entry (M14-04: "Omar
 * assigned you 12 tickets"), standing where the newest of them stood. Only
 * assignments fold, because that is the only notification a bulk edit makes
 * (`bulkOperationId` is stamped on no other kind), and only an operation that
 * assigned {@link BULK_FOLD_MIN} or more of the rows on screen; a single one
 * reads as the ordinary notification it is.
 */
export const foldBulk = (items: readonly NotificationView[]): PanelEntry[] => {
  const byOperation = new Map<string, NotificationView[]>();
  for (const item of items) {
    if (item.kind === 'assigned' && item.bulkOperationId !== null) {
      byOperation.set(item.bulkOperationId, [
        ...(byOperation.get(item.bulkOperationId) ?? []),
        item,
      ]);
    }
  }

  const entries: PanelEntry[] = [];
  const placed = new Set<string>();
  for (const item of items) {
    const operationId = item.bulkOperationId;
    const group = operationId === null ? undefined : byOperation.get(operationId);
    if (operationId === null || group === undefined || group.length < BULK_FOLD_MIN) {
      entries.push({ type: 'item', item });
    } else if (!placed.has(operationId)) {
      placed.add(operationId);
      entries.push({ type: 'bulk', operationId, items: group });
    }
  }

  return entries;
};

/** "Omar assigned you 12 tickets". */
export const bulkTitle = (t: T, items: readonly NotificationView[]): string =>
  t('admin:notifications.title.assignedBulk', {
    actor: items[0]?.actorName ?? t('admin:notifications.someone'),
    count: items.length,
  });

/** The first three references and "and 9 more": enough to recognise the batch, never a wall. */
export const bulkLine = (t: T, items: readonly NotificationView[]): string => {
  const shown = items.slice(0, 3).map((item) => item.ticketReference);
  const rest = items.length - shown.length;

  return rest <= 0
    ? shown.join(', ')
    : `${shown.join(', ')} ${t('admin:notifications.bulkMore', { count: rest })}`;
};
