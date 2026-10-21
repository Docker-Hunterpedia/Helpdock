import { Box, Radio, Typography } from '@mui/material';
import type { ReactNode } from 'react';
import { useSemanticTokens } from '../app/tokens.js';

/**
 * DESIGN §6.1 RadioCard: a single choice that needs a sentence to explain it.
 * A `label` wrapping a real Radio, so the whole card is the hit area and a
 * screen reader hears the title as the name and the sentence as the
 * description. Unchecked it is `bg.surface` on a `border.strong` edge; checked,
 * `action.primary.tint` on an `action.primary` one. The caller owns the
 * `fieldset` and `radiogroup` around the cards.
 */
export function RadioCard({
  id,
  name,
  value,
  checked,
  disabled = false,
  icon,
  title,
  tag,
  description,
  onSelect,
}: {
  readonly id: string;
  readonly name: string;
  readonly value: string;
  readonly checked: boolean;
  readonly disabled?: boolean;
  /** A 16 px Lucide icon, drawn `aria-hidden`. Left out where the board draws none. */
  readonly icon?: ReactNode;
  readonly title: string;
  /** A Tag beside the title, such as "Recommended". */
  readonly tag?: ReactNode;
  /**
   * The sentence under the title. A node, so a card can hold a control inside
   * it ("Once a day at [08:00]" in `Admin/Account-Notifications-Schedule`).
   */
  readonly description: ReactNode;
  readonly onSelect: (value: string) => void;
}): ReactNode {
  const tokens = useSemanticTokens();

  return (
    <Box
      component="label"
      htmlFor={id}
      sx={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 2,
        padding: 3,
        borderRadius: '6px',
        border: `1px solid ${checked ? tokens['action.primary'] : tokens['border.strong']}`,
        backgroundColor: checked ? tokens['action.primary.tint'] : tokens['bg.surface'],
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.6 : 1,
      }}
    >
      <Radio
        id={id}
        size="small"
        name={name}
        value={value}
        checked={checked}
        disabled={disabled}
        onChange={() => {
          onSelect(value);
        }}
        sx={{ padding: 0, marginBlockStart: '2px' }}
        slotProps={{ input: { 'aria-describedby': `${id}-description` } }}
      />
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, fontWeight: 500 }}>
          {icon === undefined ? null : (
            <Box component="span" aria-hidden="true" sx={{ display: 'inline-flex' }}>
              {icon}
            </Box>
          )}
          {title}
          {tag}
        </Box>
        <Typography
          id={`${id}-description`}
          variant="caption"
          sx={{ fontSize: 13, color: 'text.secondary' }}
        >
          {description}
        </Typography>
      </Box>
    </Box>
  );
}
