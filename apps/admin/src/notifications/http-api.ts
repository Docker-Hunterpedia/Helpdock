import type {
  NotificationList,
  NotificationPreferences,
  NotificationPreferencesView,
  PushSubscriptionCreate,
  PushSubscriptionView,
} from '@helpdock/schemas';
import {
  notificationListSchema,
  notificationPreferencesViewSchema,
  pushSubscriptionSchema,
} from '@helpdock/schemas';
import { HttpTransport } from '../auth/http-transport.js';
import type { NotificationsApi } from './api.js';

/** The real service, over the admin's one transport (so one token, one refresh). */
export class HttpNotificationsApi implements NotificationsApi {
  readonly #transport: HttpTransport;

  constructor(transport: HttpTransport = new HttpTransport()) {
    this.#transport = transport;
  }

  async list(brandId: string, filter: 'all' | 'unread'): Promise<NotificationList> {
    return notificationListSchema.parse(
      await this.#transport.request('GET', `${this.#brand(brandId)}?filter=${filter}`),
    );
  }

  async markRead(brandId: string, notificationId: string): Promise<void> {
    await this.#transport.request(
      'POST',
      `${this.#brand(brandId)}/${encodeURIComponent(notificationId)}/read`,
    );
  }

  async markAllRead(brandId: string): Promise<void> {
    await this.#transport.request('POST', `${this.#brand(brandId)}/read-all`);
  }

  async testPush(brandId: string, subscriptionId: string): Promise<void> {
    await this.#transport.request('POST', `${this.#brand(brandId)}/test-push`, { subscriptionId });
  }

  async preferences(): Promise<NotificationPreferencesView> {
    return notificationPreferencesViewSchema.parse(
      await this.#transport.request('GET', '/me/notification-preferences'),
    );
  }

  async updatePreferences(
    preferences: NotificationPreferences,
  ): Promise<NotificationPreferencesView> {
    return notificationPreferencesViewSchema.parse(
      await this.#transport.request('PUT', '/me/notification-preferences', { preferences }),
    );
  }

  async subscribe(subscription: PushSubscriptionCreate): Promise<PushSubscriptionView> {
    return pushSubscriptionSchema.parse(
      await this.#transport.request('POST', '/me/push-subscriptions', subscription),
    );
  }

  async unsubscribe(subscriptionId: string): Promise<void> {
    await this.#transport.request(
      'DELETE',
      `/me/push-subscriptions/${encodeURIComponent(subscriptionId)}`,
    );
  }

  #brand(brandId: string): string {
    return `/brands/${encodeURIComponent(brandId)}/notifications`;
  }
}
