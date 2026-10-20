import { Box } from '@mui/material';
import type { ReactNode } from 'react';
import { useT } from '../app/i18n.js';
import { Kbd } from '../ui/kbd.tsx';
import { isMac, type KeyStroke, keyCaps } from './keys.js';

/**
 * A shortcut's keys as caps: `⌘` `Enter`, or `g` then `i` for a sequence.
 * Always left to right, Arabic included: the caps are the Latin ones engraved
 * on the keyboard, and "g then i" is the order they are pressed in.
 */
export function KeyCombo({ keys }: { readonly keys: readonly KeyStroke[] }): ReactNode {
  const t = useT();
  const mac = isMac();

  return (
    <Box component="span" dir="ltr" sx={{ display: 'inline-flex', alignItems: 'center', gap: 1 }}>
      {keys.map((stroke, index) => (
        <Box
          // biome-ignore lint/suspicious/noArrayIndexKey: a sequence's strokes have no identity but their place.
          key={index}
          component="span"
          sx={{ display: 'inline-flex', alignItems: 'center', gap: 1 }}
        >
          {index === 0 ? null : (
            <Box component="span" sx={{ fontSize: 12, color: 'text.secondary' }}>
              {t('tickets:keyboard.then')}
            </Box>
          )}
          {keyCaps(stroke, mac).map((cap) => (
            <Kbd key={cap}>{cap === 'Ctrl' ? t('admin:nav.ctrlKey') : cap}</Kbd>
          ))}
        </Box>
      ))}
    </Box>
  );
}
