import {
  departmentRoom,
  type NotificationSounds,
  type SoundEvent,
  WAITING_CHAT_REMINDER_MS,
} from '@helpdock/schemas';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { currentBrand, useSession, useStaffApi, useTicketsApi } from '../../auth/session.tsx';
import { useRealtime } from '../../realtime/realtime-provider.tsx';
import { useNotificationsApi } from '../context.tsx';
import { useNotificationPreferences } from '../use-preferences.js';
import { soundPlayer } from './player.js';
import {
  isCustomerReplyForMe,
  isSoundOn,
  isWaitingChat,
  remindsWhileWaiting,
  soundForCreatedTicket,
  soundForNotificationKind,
} from './rules.js';
import { WaitingChatReminders } from './waiting-reminder.js';

/** Enough to drop a repeated frame without growing for a whole shift. */
const REMEMBERED_FRAMES = 500;

const needsDepartmentRooms = (sounds: NotificationSounds): boolean =>
  sounds.waitingChat || sounds.newConversation || sounds.customerReply;

/**
 * The live sounds of M14-25, mounted once in the signed-in shell.
 *
 * It listens on the socket this tab already holds. The frames carry ids only,
 * so each candidate is read over REST before anything plays: that is what
 * tells a customer's message from a colleague's, an unassigned chat from an
 * assigned one, and it applies the person's department scope for free. Nothing
 * plays for the person's own actions (a notification is never made for its
 * actor, a manual ticket is silent, only a customer's message is a reply), for
 * an event switched off, or while another sound is still playing.
 *
 * Department rooms are joined only while a ticket sound is on, so a person
 * with every sound off costs the socket nothing.
 */
export function useNotificationSounds(): void {
  const session = useSession();
  const brandId = currentBrand(session).id;
  const selfId = session.user.id;
  const { client } = useRealtime();
  const tickets = useTicketsApi();
  const notifications = useNotificationsApi();
  const sounds = useNotificationPreferences().data?.sounds;
  const staffApi = useStaffApi();
  // A key of its own: the Departments tab caches `['departments', brandId]`
  // from another api, and two queryFns on one key reorder each other's lists.
  const departments =
    useQuery({
      queryKey: ['notification-sounds', 'departments', brandId],
      queryFn: () => staffApi.departments(brandId),
      staleTime: 5 * 60_000,
      enabled: sounds !== undefined && needsDepartmentRooms(sounds),
    }).data?.departments ?? [];

  // The handlers below are set up once per brand and read the latest choice
  // from here, so toggling a switch does not tear the subscription down.
  const soundsRef = useRef<NotificationSounds | undefined>(sounds);
  soundsRef.current = sounds;

  const departmentKey = departments
    .map((department) => department.id)
    .sort()
    .join(',');
  const wantsRooms = sounds !== undefined && needsDepartmentRooms(sounds);

  useEffect(() => {
    if (!wantsRooms || departmentKey === '') {
      return;
    }
    const leaves = departmentKey
      .split(',')
      .map((departmentId) => client.joinRoom(departmentRoom(departmentId)));

    return () => {
      for (const leave of leaves) {
        leave();
      }
    };
  }, [client, wantsRooms, departmentKey]);

  useEffect(() => {
    const handled = new Set<string>();
    const firstTime = (key: string): boolean => {
      if (handled.has(key)) {
        return false;
      }
      if (handled.size >= REMEMBERED_FRAMES) {
        handled.clear();
      }
      handled.add(key);

      return true;
    };

    const enabled = (event: SoundEvent): boolean => {
      const current = soundsRef.current;

      return current !== undefined && isSoundOn(current, event);
    };

    const play = (event: SoundEvent): void => {
      void soundPlayer.play(event);
    };

    const reminders = new WaitingChatReminders({
      intervalMs: WAITING_CHAT_REMINDER_MS,
      stillWaiting: async (ticketId) => {
        const current = soundsRef.current;
        if (current === undefined || !remindsWhileWaiting(current)) {
          return false;
        }

        return isWaitingChat((await tickets.ticket(brandId, ticketId)).ticket);
      },
      remind: () => {
        play('waitingChat');
      },
    });

    const onCreated = async (ticketId: string): Promise<void> => {
      const { ticket } = await tickets.ticket(brandId, ticketId);
      const event = soundForCreatedTicket(ticket);
      if (event === 'waitingChat') {
        if (enabled('waitingChat')) {
          play('waitingChat');
          if (soundsRef.current !== undefined && remindsWhileWaiting(soundsRef.current)) {
            reminders.track(ticketId);
          }

          return;
        }
        // A chat waiting is also a new conversation for somebody who wants that one.
        if (enabled('newConversation')) {
          play('newConversation');
        }

        return;
      }
      if (event !== null && enabled(event)) {
        play(event);
      }
    };

    const onReply = async (ticketId: string, messageId: string, seq: number): Promise<void> => {
      const [{ ticket }, page] = await Promise.all([
        tickets.ticket(brandId, ticketId),
        tickets.messages(brandId, ticketId, seq - 1),
      ]);
      const message = page.messages.find((candidate) => candidate.id === messageId);
      if (message !== undefined && isCustomerReplyForMe(ticket, message, selfId)) {
        play('customerReply');
      }
    };

    const onNotification = async (notificationId: string): Promise<void> => {
      const list = await notifications.list(brandId, 'unread');
      const row = list.items.find((item) => item.id === notificationId);
      const event = row === undefined ? null : soundForNotificationKind(row.kind);
      if (event !== null && enabled(event)) {
        play(event);
      }
    };

    // A failed read is a missed sound, never an error: the bell has the news.
    const ignoreFailure = (): void => undefined;

    const unsubscribe = client.subscribe({
      ticketChanged: (change) => {
        if (change.brandId !== brandId) {
          return;
        }
        if (change.event === 'ticket.created') {
          if (
            firstTime(`created:${change.ticketId}`) &&
            (enabled('waitingChat') || enabled('newConversation'))
          ) {
            void onCreated(change.ticketId).catch(ignoreFailure);
          }

          return;
        }
        // Picked up, closed or moved: the reminder asks REST and lets go.
        if (reminders.has(change.ticketId)) {
          void tickets
            .ticket(brandId, change.ticketId)
            .then(({ ticket }) => {
              if (!isWaitingChat(ticket)) {
                reminders.release(change.ticketId);
              }
            })
            .catch(ignoreFailure);
        }
      },
      ticketMessage: (event) => {
        if (
          event.brandId === brandId &&
          event.event === 'ticket.replied' &&
          event.kind === 'public' &&
          event.seq > 1 &&
          enabled('customerReply') &&
          firstTime(`reply:${event.messageId}`)
        ) {
          void onReply(event.ticketId, event.messageId, event.seq).catch(ignoreFailure);
        }
      },
      notificationCreated: (created) => {
        if (
          created.brandId === brandId &&
          enabled('assignedOrMentioned') &&
          firstTime(`notification:${created.notificationId}`)
        ) {
          void onNotification(created.notificationId).catch(ignoreFailure);
        }
      },
    });

    return () => {
      unsubscribe();
      reminders.clear();
    };
  }, [client, tickets, notifications, brandId, selfId]);
}
