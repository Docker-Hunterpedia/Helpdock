import { Box } from '@mui/material';
import type { ReactNode } from 'react';
import { useT } from '../app/i18n.js';
import { useSemanticTokens } from '../app/tokens.js';
import { Kbd } from '../ui/kbd.tsx';
import type { PendingSequence } from './dispatch.js';
import { isSequence, SHORTCUT_LIST, type ShortcutPermission, shortcutLabel } from './registry.js';

/**
 * The chip at the bottom of the screen while a `g` sequence waits for its
 * second key (`Admin/ShortcutSheet`, "waiting for a sequence"): the `g` cap,
 * then the letters that can follow and where each goes. DESIGN §6.4's Toast
 * surface, `bg.inverse` at 13 px.
 *
 * The live region is always mounted and only its content comes and goes, so
 * a screen reader announces the chip when it appears. Only a pending
 * sequence exposes a status; an idle chip is not an empty toast.
 */
export function SequenceChip({
  pending,
  permits,
}: {
  readonly pending: PendingSequence | null;
  readonly permits: (permission: ShortcutPermission | undefined) => boolean;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();

  const next =
    pending === null
      ? []
      : SHORTCUT_LIST.filter(
          (shortcut) =>
            isSequence(shortcut) &&
            shortcut.keys[0]?.key === pending.prefix &&
            permits(shortcut.permission),
        );

  return (
    <Box
      role={pending === null ? undefined : 'status'}
      aria-live="polite"
      aria-atomic="true"
      sx={{
        position: 'fixed',
        insetBlockEnd: 24,
        insetInline: 0,
        marginInline: 'auto',
        width: 'fit-content',
        maxWidth: 'calc(100% - 32px)',
        zIndex: (theme) => theme.zIndex.snackbar,
        pointerEvents: 'none',
      }}
    >
      {pending === null ? null : (
        <Box
          sx={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 2,
            paddingBlock: 1,
            paddingInline: 3,
            borderRadius: '6px',
            backgroundColor: tokens['bg.inverse'],
            color: tokens['text.inverse'],
            fontSize: 13,
            lineHeight: '20px',
          }}
        >
          <Kbd>{pending.prefix}</Kbd>
          <span>
            {'… '}
            {next.map((shortcut, index) => (
              <span key={shortcut.id}>
                {index === 0 ? null : ' · '}
                <bdi>{shortcut.keys[1]?.key}</bdi> {t(shortcutLabel(shortcut.id))}
              </span>
            ))}
          </span>
        </Box>
      )}
    </Box>
  );
}
