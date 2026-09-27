import type { Ticket } from '@helpdock/schemas';
import { Box, IconButton, Typography } from '@mui/material';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { useT } from '../../app/i18n.js';
import { useSemanticTokens } from '../../app/tokens.js';
import {
  describeAction,
  type StagedMacro,
  type StagingLookups,
} from '../../tickets/macro-staging.js';
import { lineText } from './macro-picker.tsx';

/**
 * What an applied macro will do when the reply is sent, as chips above the
 * composer (M3-06, artboard `AdminComposerMacros`, DESIGN §6.1 StagedActions):
 * "Apply fills the composer and stages the actions as chips above it; each can
 * be removed before sending."
 *
 * The group is labelled with the macro's name, and each chip's remove button
 * names the action it removes, so the state is read out rather than seen.
 */
export function StagedMacroChips({
  staged,
  ticket,
  lookups,
  onRemove,
  onClear,
}: {
  readonly staged: StagedMacro;
  readonly ticket: Ticket;
  readonly lookups: StagingLookups;
  onRemove(index: number): void;
  onClear(): void;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();

  return (
    <Box
      role="group"
      aria-label={t('macros:staged.label', { name: staged.macro.name })}
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        flexWrap: 'wrap',
        marginBlockEnd: 2,
      }}
    >
      <Typography variant="caption" sx={{ color: 'text.secondary' }}>
        {t('macros:staged.via', { name: staged.macro.name })}
      </Typography>
      {staged.actions.map((action, index) => {
        const text = lineText(describeAction(action, ticket, lookups), t);
        return (
          <Box
            // The staged list only shrinks, and only by position.
            // biome-ignore lint/suspicious/noArrayIndexKey: see above.
            key={index}
            sx={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 1,
              minHeight: 24,
              paddingInlineStart: 2,
              borderRadius: '6px',
              border: `1px solid ${tokens['border.default']}`,
              backgroundColor: tokens['bg.surface'],
            }}
          >
            <Typography variant="caption">{text}</Typography>
            <IconButton
              size="small"
              aria-label={t('macros:staged.remove', { action: text })}
              onClick={() => {
                onRemove(index);
              }}
            >
              <X size={14} aria-hidden="true" />
            </IconButton>
          </Box>
        );
      })}
      <IconButton size="small" aria-label={t('macros:staged.clear')} onClick={onClear}>
        <X size={16} aria-hidden="true" />
      </IconButton>
    </Box>
  );
}
