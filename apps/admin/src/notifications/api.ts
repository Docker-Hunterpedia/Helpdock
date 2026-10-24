import type {
  NotificationList,
  NotificationPreferences,
  NotificationPreferencesUpdate,
  NotificationPreferencesView,
  PushSubscriptionCreate,
  PushSubscriptionView,
} from '@helpdock/schemas';

/**
 * Everything the bell, its panel and the Notifications tab need (M3-07).
 * `MockNotificationsApi` is the fixture the unit tests and the mock Playwright
 * projects run against; `HttpNotificationsApi` is the real service.
 */
export interface NotificationsApi {
  list(brandId: string, filter: 'all' | 'unread'): Promise<NotificationList>;
  markRead(brandId: string, notificationId: string): Promise<void>;
  markAllRead(brandId: string): Promise<void>;
  testPush(brandId: string, subscriptionId: string): Promise<void>;
  /** M14-11. A test email to the signed-in person's own address, through the outbox. */
  testEmail(brandId: string): Promise<void>;

  preferences(): Promise<NotificationPreferencesView>;
  updatePreferences(preferences: NotificationPreferences): Promise<NotificationPreferencesView>;
  /** M14-11. The schedule, digest hour, pause and "Turn email back on", each on its own. */
  updateSettings(update: NotificationPreferencesUpdate): Promise<NotificationPreferencesView>;
  subscribe(subscription: PushSubscriptionCreate): Promise<PushSubscriptionView>;
  unsubscribe(subscriptionId: string): Promise<void>;
}
