import type {
  NotificationList,
  NotificationPreferencesView,
  PushSubscriptionView,
} from '@helpdock/schemas';
import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ZodSerializerDto, ZodValidationPipe } from 'nestjs-zod';
import { requireStaffPrincipalId } from '../auth/principal.js';
import { Authenticated, Requires } from '../auth/route-declaration.js';
import { getTx, requireRequestContext } from '../context/request-context.js';
import {
  NotificationBrandParamDto,
  NotificationListDto,
  NotificationListQueryDto,
  NotificationParamDto,
  NotificationPreferencesUpdateDto,
  NotificationPreferencesViewDto,
  PushSubscriptionCreateDto,
  PushSubscriptionDto,
  PushSubscriptionParamDto,
  PushTestRequestDto,
} from './dto.js';
import { NotificationsService, type PanelContext } from './notifications.service.js';

/**
 * The bell and its panel (M3-07, artboard `AdminNotifications`). Brand-scoped:
 * the panel lists the brand on screen, and each row's ticket is read under the
 * reader's own department policy.
 *
 * `ticket:read`, which every role holds, because a notification is about a
 * ticket and being told about one is reading it. Marking one read writes only
 * the reader's own row, like saving a personal view does.
 */
@Controller('api/brands/:brandId/notifications')
export class NotificationsController {
  readonly #notifications: NotificationsService;

  constructor(@Inject(NotificationsService) notifications: NotificationsService) {
    this.#notifications = notifications;
  }

  @Get()
  @Requires('ticket:read')
  @ZodSerializerDto(NotificationListDto)
  list(
    @Param(new ZodValidationPipe(NotificationBrandParamDto)) _params: NotificationBrandParamDto,
    @Query(new ZodValidationPipe(NotificationListQueryDto)) query: NotificationListQueryDto,
  ): Promise<NotificationList> {
    return this.#notifications.list(requirePanelContext(), query);
  }

  @Post('read-all')
  @Requires('ticket:read')
  @HttpCode(HttpStatus.NO_CONTENT)
  async readAll(
    @Param(new ZodValidationPipe(NotificationBrandParamDto)) _params: NotificationBrandParamDto,
  ): Promise<void> {
    await this.#notifications.markAllRead(requirePanelContext());
  }

  @Post(':notificationId/read')
  @Requires('ticket:read')
  @HttpCode(HttpStatus.NO_CONTENT)
  async read(
    @Param(new ZodValidationPipe(NotificationParamDto)) { notificationId }: NotificationParamDto,
  ): Promise<void> {
    await this.#notifications.markRead(requirePanelContext(), notificationId);
  }

  /** "Send a test" on the Notifications tab: brand-scoped because the outbox is. */
  @Post('test-push')
  @Requires('ticket:read')
  @HttpCode(HttpStatus.ACCEPTED)
  async testPush(
    @Param(new ZodValidationPipe(NotificationBrandParamDto)) _params: NotificationBrandParamDto,
    @Body(new ZodValidationPipe(PushTestRequestDto)) body: PushTestRequestDto,
  ): Promise<void> {
    await this.#notifications.testPush(requirePanelContext(), body.subscriptionId);
  }
}

/**
 * The Notifications tab of Your account (`/me/notifications`). Not brand-scoped:
 * one person is told the same way in every brand, and a browser subscribes
 * once. Like the rest of `/api/me`, every route acts on the caller alone.
 */
@Controller('api/me')
export class NotificationPreferencesController {
  readonly #notifications: NotificationsService;

  constructor(@Inject(NotificationsService) notifications: NotificationsService) {
    this.#notifications = notifications;
  }

  @Get('notification-preferences')
  @Authenticated()
  @ZodSerializerDto(NotificationPreferencesViewDto)
  preferences(): Promise<NotificationPreferencesView> {
    return this.#notifications.preferences(getTx(), userId());
  }

  @Put('notification-preferences')
  @Authenticated()
  @ZodSerializerDto(NotificationPreferencesViewDto)
  updatePreferences(
    @Body(new ZodValidationPipe(NotificationPreferencesUpdateDto))
    body: NotificationPreferencesUpdateDto,
  ): Promise<NotificationPreferencesView> {
    return this.#notifications.updatePreferences(getTx(), userId(), body.preferences);
  }

  @Post('push-subscriptions')
  @Authenticated()
  @ZodSerializerDto(PushSubscriptionDto)
  subscribe(
    @Body(new ZodValidationPipe(PushSubscriptionCreateDto)) body: PushSubscriptionCreateDto,
  ): Promise<PushSubscriptionView> {
    return this.#notifications.addSubscription(getTx(), userId(), body);
  }

  @Delete('push-subscriptions/:subscriptionId')
  @Authenticated()
  @HttpCode(HttpStatus.NO_CONTENT)
  async unsubscribe(
    @Param(new ZodValidationPipe(PushSubscriptionParamDto))
    { subscriptionId }: PushSubscriptionParamDto,
  ): Promise<void> {
    await this.#notifications.removeSubscription(getTx(), userId(), subscriptionId);
  }
}

/** The guard has already refused anything but a staff principal with a session. */
const userId = (): string => requireStaffPrincipalId(requireRequestContext().principal);

/** The request's transaction, brand and staff member. An api key has no bell. */
const requirePanelContext = (): PanelContext => {
  const request = requireRequestContext();
  const principal = request.principal;
  const brandId = request.targetBrandId;

  if (principal?.type !== 'staff' || brandId === null || principal.brands[brandId] === undefined) {
    throw new ForbiddenException('Notifications belong to staff');
  }

  return { tx: getTx(), brandId, userId: principal.id };
};
