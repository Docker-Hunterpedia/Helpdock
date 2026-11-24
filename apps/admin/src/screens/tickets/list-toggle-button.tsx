import { Box, IconButton, Tooltip } from '@mui/material';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import type { ReactNode, Ref } from 'react';
import { useT } from '../../app/i18n.js';
import { useSemanticTokens } from '../../app/tokens.js';
import { KeyCombo } from '../../keyboard/key-combo.tsx';
import { useAriaKeyShortcuts } from '../../keyboard/keyboard-provider.tsx';
import { shortcutById } from '../../keyboard/registry.js';

/**
 * M14-30: the 32 px button at the inline start of the ticket header that hides
 * and shows the ticket list. It is the visible half of `[`, so a person who
 * does not know the key can still find the control. `aria-pressed` is true
 * while the list is hidden; the icon is the panel the press would move.
 */
export function ListToggleButton({
  hidden,
  buttonRef,
  onToggle,
}: {
  readonly hidden: boolean;
  readonly buttonRef: Ref<HTMLButtonElement>;
  onToggle(): void;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const keyShortcuts = useAriaKeyShortcuts('list.toggleColumn');
  const label = t(hidden ? 'tickets:list.open' : 'tickets:list.close');
  const Icon = hidden ? PanelLeftOpen : PanelLeftClose;

  return (
    <Tooltip
      describeChild
      disableInteractive
      title={
        <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
          {label}
          {keyShortcuts === undefined ? null : (
            <KeyCombo keys={shortcutById('list.toggleColumn').keys} />
          )}
        </Box>
      }
    >
      <IconButton
        ref={buttonRef}
        aria-label={label}
        aria-pressed={hidden}
        aria-keyshortcuts={keyShortcuts}
        onClick={onToggle}
        sx={{
          width: 32,
          height: 32,
          flexShrink: 0,
          borderRadius: '6px',
          border: `1px solid ${tokens['border.default']}`,
          backgroundColor: tokens['bg.surface'],
        }}
      >
        <Icon size={16} aria-hidden="true" className="mirror-in-rtl" />
      </IconButton>
    </Tooltip>
  );
}
