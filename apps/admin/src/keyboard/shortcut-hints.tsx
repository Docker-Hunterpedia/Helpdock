import { Box, ButtonBase } from '@mui/material';
import type { ReactNode } from 'react';
import { useT } from '../app/i18n.js';
import { KeyCombo } from './key-combo.tsx';
import { useKeyboard } from './keyboard-provider.tsx';
import { type ShortcutId, shortcutById, shortcutLabel } from './registry.js';

/**
 * A line of "keys, name" hints under an empty state (M14-06, `Admin/Tickets-Empty`),
 * read from the shortcut registry so a hint cannot name a key that does nothing.
 *
 * Draws nothing while single-key shortcuts are off (the hint would teach a key
 * that does not answer) and leaves out a shortcut the person may not use. A
 * shortcut with a modifier still answers with the switch off, so it stays. The
 * `general.shortcuts` hint is a button, because the key it names is one of
 * those the switch turns off and the sheet must stay reachable.
 */
export function ShortcutHints({ ids }: { readonly ids: readonly ShortcutId[] }): ReactNode {
  const t = useT();
  const { singleKeys, permits, openSheet } = useKeyboard();

  const shown = ids
    .map((id) => shortcutById(id))
    .filter(
      (shortcut) => permits(shortcut.permission) && (singleKeys || shortcut.keys[0]?.mod === true),
    );
  if (shown.length === 0) {
    return null;
  }

  return (
    <Box
      component="ul"
      aria-label={t('tickets:keyboard.hintsLabel')}
      sx={{
        display: 'flex',
        flexWrap: 'wrap',
        justifyContent: 'center',
        columnGap: 5,
        rowGap: 2,
        margin: 0,
        padding: 0,
        listStyle: 'none',
        fontSize: 12,
        lineHeight: '16px',
        color: 'text.secondary',
      }}
    >
      {shown.map((shortcut) => {
        const content = (
          <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
            <KeyCombo keys={shortcut.keys} compact />
            <span>{t(shortcutLabel(shortcut.id))}</span>
          </Box>
        );

        return (
          <li key={shortcut.id}>
            {shortcut.id === 'general.shortcuts' ? (
              <ButtonBase
                onClick={openSheet}
                sx={{ font: 'inherit', color: 'inherit', borderRadius: '4px' }}
              >
                {content}
              </ButtonBase>
            ) : (
              content
            )}
          </li>
        );
      })}
    </Box>
  );
}
