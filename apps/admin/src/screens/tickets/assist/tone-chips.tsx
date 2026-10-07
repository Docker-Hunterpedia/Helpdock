import type { AssistTone } from '@helpdock/schemas';
import { ToggleButton, ToggleButtonGroup } from '@mui/material';
import type { ReactNode } from 'react';
import { useT } from '../../../app/i18n.js';

const TONES: readonly AssistTone[] = ['friendlier', 'formal', 'shorter'];

/**
 * The "Rewritten" card's tone row (DESIGN §6.3 AISuggestionCard): 28 px
 * toggle chips. Choosing another tone reruns on the agent's own draft, never
 * on the last rewrite.
 */
export function ToneChips({
  tone,
  busy,
  onTone,
}: {
  readonly tone: AssistTone;
  readonly busy: boolean;
  onTone(tone: AssistTone): void;
}): ReactNode {
  const t = useT();
  return (
    <ToggleButtonGroup
      exclusive
      size="small"
      value={tone}
      disabled={busy}
      aria-label={t('tickets:assist.rewrite.tone')}
      onChange={(_event, next: AssistTone | null) => {
        if (next !== null && next !== tone) {
          onTone(next);
        }
      }}
    >
      {TONES.map((candidate) => (
        <ToggleButton key={candidate} value={candidate} sx={{ height: 28, fontSize: 12 }}>
          {t(`tickets:assist.tones.${candidate}`)}
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  );
}
