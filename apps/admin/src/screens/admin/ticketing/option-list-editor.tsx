import { CUSTOM_FIELD_OPTION_MAX } from '@helpdock/schemas';
import { Box, Button, IconButton, TextField, Typography } from '@mui/material';
import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react';
import { type ReactNode, useId } from 'react';
import { useT } from '../../../app/i18n.js';
import { useSemanticTokens } from '../../../app/tokens.js';
import { moveBy } from './reorder.js';

/**
 * The options of a `select` or `multi_select` field: a row per choice, each a
 * real text input, with Remove and two move buttons beside it.
 *
 * **Keyboard first.** `↑` and `↓` inside a row move that option, and the two
 * buttons do the same thing for a pointer — the same rule the department list
 * follows, and for the same reason: a keyboard alternative that drifts from the
 * pointer one is worse than none. Focus stays on the input that moved, so a
 * person can reorder several without reaching for the mouse.
 *
 * The order matters: it is the order the menu offers, and the api stores the
 * array as it arrives.
 */
export function OptionListEditor({
  options,
  disabled,
  onChange,
}: {
  readonly options: readonly string[];
  readonly disabled: boolean;
  onChange(next: readonly string[]): void;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const listId = useId();

  /**
   * Moving an option is moving a *position*, not a value: two options may
   * legitimately read the same while they are being typed, and `reorder.ts`
   * works on ids. Positions are the ids here.
   */
  const move = (index: number, offset: number): void => {
    const positions = options.map((_option, position) => String(position));
    const moved = moveBy(positions, String(index), offset);
    if (moved === positions) {
      return;
    }

    onChange(moved.map((position) => options[Number(position)] ?? ''));
  };

  const replace = (index: number, value: string): void => {
    onChange(options.map((option, position) => (position === index ? value : option)));
  };

  const remove = (index: number): void => {
    onChange(options.filter((_option, position) => position !== index));
  };

  return (
    <Box role="group" aria-labelledby={listId}>
      <Typography
        id={listId}
        component="p"
        sx={{ fontSize: 13, fontWeight: 500, lineHeight: '20px', marginBlockEnd: '6px' }}
      >
        {t('ticketing:customFields.editor.options')}
      </Typography>

      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {options.map((option, index) => {
          const name =
            option === ''
              ? t('ticketing:customFields.editor.optionLabel', { position: index + 1 })
              : option;

          return (
            <Box
              // The list is reordered and edited in place, so the index is the
              // identity: two options may read the same while one is being typed.
              // biome-ignore lint/suspicious/noArrayIndexKey: an option has no id; its position is what it is.
              key={index}
              sx={{ display: 'flex', alignItems: 'center', gap: 1 }}
            >
              <TextField
                value={option}
                disabled={disabled}
                size="small"
                onChange={(event) => {
                  replace(index, event.target.value);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                    event.preventDefault();
                    move(index, event.key === 'ArrowUp' ? -1 : 1);
                  }
                }}
                slotProps={{
                  htmlInput: {
                    maxLength: CUSTOM_FIELD_OPTION_MAX,
                    'aria-label': t('ticketing:customFields.editor.optionLabel', {
                      position: index + 1,
                    }),
                  },
                }}
                sx={{ flex: 1 }}
              />
              <IconButton
                aria-label={t('ticketing:customFields.editor.moveOptionUp', { name })}
                disabled={disabled || index === 0}
                onClick={() => {
                  move(index, -1);
                }}
              >
                <ArrowUp size={16} aria-hidden="true" />
              </IconButton>
              <IconButton
                aria-label={t('ticketing:customFields.editor.moveOptionDown', { name })}
                disabled={disabled || index === options.length - 1}
                onClick={() => {
                  move(index, 1);
                }}
              >
                <ArrowDown size={16} aria-hidden="true" />
              </IconButton>
              <IconButton
                aria-label={t('ticketing:customFields.editor.removeOption', { name })}
                disabled={disabled}
                onClick={() => {
                  remove(index);
                }}
              >
                <X size={16} aria-hidden="true" />
              </IconButton>
            </Box>
          );
        })}
      </Box>

      <Button
        variant="text"
        disabled={disabled}
        startIcon={<Plus size={16} aria-hidden="true" />}
        onClick={() => {
          onChange([...options, '']);
        }}
        sx={{ marginBlockStart: 2 }}
      >
        {t('ticketing:customFields.editor.addOption')}
      </Button>

      <Typography
        variant="caption"
        component="p"
        sx={{ color: tokens['text.secondary'], marginBlockStart: '6px' }}
      >
        {t('ticketing:customFields.editor.optionsHint')}
      </Typography>
    </Box>
  );
}
