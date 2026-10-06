import type { AssistCallMeta } from '@helpdock/schemas';
import type { ReactNode } from 'react';
import { useT } from '../../../app/i18n.js';
import { AiLogDetails, formatCost } from '../ai/ai-log-disclosure.tsx';

/**
 * DESIGN §6.3 AILogDisclosure under an agent assist result (M7-05): the same
 * disclosure auto-reply draws, from the figures the assist answer carries —
 * model, tokens, cost and redactions of its `ai_calls` row.
 */
export function AssistLogDisclosure({ meta }: { readonly meta: AssistCallMeta }): ReactNode {
  const t = useT();
  const redactions =
    meta.redactionCount === 0
      ? '0'
      : `${String(meta.redactionCount)} · ${meta.redactionKinds
          .map((kind) => t(`tickets:assist.piiKinds.${kind}`))
          .join(', ')}`;

  return (
    <AiLogDetails
      summary={`${meta.model} · ${formatCost(meta.costUsd)}`}
      rows={[
        [t('tickets:autoReply.logModel'), `${meta.model} · ${meta.provider}`],
        [
          t('tickets:autoReply.logTokens'),
          t('tickets:autoReply.tokensValue', {
            tokensIn: meta.tokensIn,
            tokensOut: meta.tokensOut,
          }),
        ],
        [t('tickets:autoReply.logCost'), formatCost(meta.costUsd)],
        [t('tickets:autoReply.logRedactions'), redactions],
      ]}
    />
  );
}
