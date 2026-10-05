import { auditLog } from '@helpdock/db';
import { type OutboxEventHandler, registerEventHandler } from '@helpdock/jobs';
import { z } from 'zod';
import { AI_BUDGET_ALERT_EVENT } from './budget-meter.js';

/**
 * The `ai.budget_alert` event (M7-08): a brand reached 80 % or 100 % of a
 * budget window. Written by the budget meter in the same transaction as the
 * `ai_calls` row that crossed the line, at most once per window and level.
 *
 * What it does today is put the alert where an Admin already looks: an
 * `ai.budget_alert` row in the brand's audit log, and the warning or
 * exceeded state on the AI settings response that the `Admin/AI-Assistant`
 * screen (M7-10) shows. Staff notifications are about a ticket — a row of
 * `notifications` names one, and the bell's panel draws one — so an email or
 * a bell entry for a budget waits for its own design rather than borrowing a
 * ticket notification's shape; it subscribes to this same event when it
 * comes.
 */

export const budgetAlertPayloadSchema = z.object({
  period: z.enum(['day', 'month']),
  periodStart: z.iso.date(),
  level: z.enum(['warning', 'exceeded']),
  spentUsd: z.number().nonnegative(),
  limitUsd: z.number().positive(),
});

export const handleBudgetAlert: OutboxEventHandler = async ({
  tx,
  brandId,
  outboxId,
  payload,
  log,
}) => {
  const alert = budgetAlertPayloadSchema.parse(payload);
  await tx.insert(auditLog).values({
    brandId,
    actorType: 'system',
    actorId: outboxId,
    action: 'ai.budget_alert',
    targetType: 'brand',
    targetId: brandId,
    meta: alert,
  });
  log.warn({ event: AI_BUDGET_ALERT_EVENT, brandId, ...alert }, 'AI budget threshold reached');
};

export const registerAiEventHandlers = (): void => {
  registerEventHandler(AI_BUDGET_ALERT_EVENT, handleBudgetAlert);
};
