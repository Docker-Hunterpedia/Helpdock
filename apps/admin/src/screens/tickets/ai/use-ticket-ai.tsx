import type { AiCallView, Ticket } from '@helpdock/schemas';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useT } from '../../../app/i18n.js';
import { usePreferences } from '../../../app/providers.tsx';
import { useTicketsApi } from '../../../auth/session.tsx';
import { ticketKeys } from '../../../tickets/keys.js';
import { useToast } from '../../../ui/toasts.tsx';
import { messageTime } from '../format.js';
import { AIPausedStrip } from './ai-paused-strip.tsx';
import { AiUsageCard } from './ai-usage-card.tsx';

/**
 * The ticket view's auto-reply half (M7-06, `Admin/Ticket-AI`), in one hook
 * so the view only places what it returns: the AI log the thread's
 * disclosures read, the AIPausedStrip with "Return to assistant", and the
 * "AI on this ticket" card. A ticket the assistant never took part in has no
 * `ai` state and gets none of them.
 */

export interface ThreadAi {
  /** The `ai_calls` row behind a message, once the log has loaded. */
  callFor(callId: string | null): AiCallView | undefined;
}

export interface TicketAi {
  readonly thread: ThreadAi;
  readonly strip: ReactNode;
  readonly card: ReactNode;
}

export function useTicketAi({
  brandId,
  ticket,
  canWrite,
  now,
}: {
  readonly brandId: string;
  readonly ticket: Ticket | undefined;
  readonly canWrite: boolean;
  readonly now: number;
}): TicketAi {
  const t = useT();
  const api = useTicketsApi();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { locale } = usePreferences();
  const ticketId = ticket?.id ?? '';
  const state = ticket?.ai;

  const log = useQuery({
    queryKey: [...ticketKeys.detail(brandId, ticketId), 'ai-calls'],
    queryFn: () => api.aiCalls(brandId, ticketId),
    enabled: state !== undefined,
  });
  const resume = useMutation({
    mutationFn: () => api.resumeAssistant(brandId, ticketId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ticketKeys.detail(brandId, ticketId) });
      toast({ tone: 'success', message: t('tickets:autoReply.resumed') });
    },
    onError: () => {
      toast({ tone: 'danger', message: t('tickets:autoReply.resumeFailed') });
    },
  });

  const calls = log.data?.items ?? [];
  const pausedAt = state?.pausedAt ?? null;

  return {
    thread: {
      callFor: (callId) => (callId === null ? undefined : calls.find((call) => call.id === callId)),
    },
    strip:
      pausedAt === null ? null : (
        <AIPausedStrip
          time={messageTime(pausedAt, locale, now)}
          canResume={canWrite}
          busy={resume.isPending}
          onResume={() => {
            resume.mutate();
          }}
        />
      ),
    card: calls.length === 0 ? null : <AiUsageCard calls={calls} />,
  };
}
