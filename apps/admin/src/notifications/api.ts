import type {
  NotificationList,
  NotificationPreferences,
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

  preferences(): Promise<NotificationPreferencesView>;
  updatePreferences(preferences: NotificationPreferences): Promise<NotificationPreferencesView>;
  subscribe(subscription: PushSubscriptionCreate): Promise<PushSubscriptionView>;
  unsubscribe(subscriptionId: string): Promise<void>;
}
