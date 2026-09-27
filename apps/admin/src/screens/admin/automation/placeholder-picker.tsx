import { CANNED_PLACEHOLDERS, type CannedPlaceholder } from '@helpdock/schemas';
import { Box, Paper, TextField, Typography } from '@mui/material';
import { type KeyboardEvent, type ReactNode, useId, useState } from 'react';
import { useT } from '../../../app/i18n.js';
import { useSemanticTokens } from '../../../app/tokens.js';

/**
 * The placeholder list under a reply textarea (artboard `AdminAutomationMacros`,
 * DESIGN §6.1 PlaceholderPicker): a search box that is a combobox, a listbox
 * of the placeholders grouped as the artboard groups them, each with a sample
 * of what it becomes, and a caption saying where it goes.
 *
 * Keyboard first: ↑ and ↓ move, Enter inserts, Esc closes and hands focus back
 * to whoever opened it. The options are the allow-list the renderer fills,
 * never free text, so an author cannot insert a name nothing will replace.
 */

const GROUPS: readonly { key: 'contact' | 'ticket'; names: readonly CannedPlaceholder[] }[] = [
  {
    key: 'contact',
    names: CANNED_PLACEHOLDERS.filter((name) => name.startsWith('contact.')),
  },
  {
    key: 'ticket',
    names: CANNED_PLACEHOLDERS.filter((name) => !name.startsWith('contact.')),
  },
];

export interface PlaceholderPickerProps {
  /** The sample each placeholder shows beside it. */
  readonly samples: ReadonlyMap<string, string>;
  onPick(name: CannedPlaceholder): void;
  onClose(): void;
}

export function PlaceholderPicker({ samples, onPick, onClose }: PlaceholderPickerProps): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const listId = useId();
  const [term, setTerm] = useState('');
  const [active, setActive] = useState(0);

  const needle = term.trim().toLowerCase();
  const groups = GROUPS.map((group) => ({
    ...group,
    names: group.names.filter(
      (name) =>
        needle === '' ||
        name.includes(needle) ||
        (samples.get(name) ?? '').toLowerCase().includes(needle),
    ),
  })).filter((group) => group.names.length > 0);
  const flat = groups.flatMap((group) => group.names);
  const current = flat[Math.min(active, flat.length - 1)];
  const optionId = (name: string): string => `${listId}-${name.replace('.', '-')}`;

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive((index) => (flat.length === 0 ? 0 : (index + step + flat.length) % flat.length));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (current !== undefined) {
        onPick(current);
      }
    } else if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  };

  return (
    <Paper
      elevation={2}
      sx={{ marginBlockStart: 2, padding: 2, display: 'grid', gap: 2, borderRadius: '6px' }}
    >
      <TextField
        size="small"
        type="search"
        autoFocus
        value={term}
        placeholder={t('macros:editor.placeholders.search')}
        onChange={(event) => {
          setTerm(event.target.value);
          setActive(0);
        }}
        onKeyDown={onKeyDown}
        slotProps={{
          htmlInput: {
            role: 'combobox',
            'aria-label': t('macros:editor.placeholders.search'),
            'aria-expanded': true,
            'aria-controls': listId,
            'aria-activedescendant': current === undefined ? undefined : optionId(current),
          },
        }}
      />
      <Box id={listId} role="listbox" aria-label={t('macros:editor.placeholders.list')}>
        {groups.map((group) => (
          <Box
            key={group.key}
            role="group"
            aria-label={t(`macros:editor.placeholders.groups.${group.key}`)}
          >
            <Typography
              variant="caption"
              component="div"
              aria-hidden="true"
              sx={{ color: 'text.secondary', paddingBlock: 1, paddingInline: 2 }}
            >
              {t(`macros:editor.placeholders.groups.${group.key}`)}
            </Typography>
            {group.names.map((name) => (
              <Box
                key={name}
                id={optionId(name)}
                role="option"
                aria-selected={name === current}
                onMouseDown={(event) => {
                  // Before the input blurs, so the pick lands where the caret was.
                  event.preventDefault();
                  onPick(name);
                }}
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 3,
                  minHeight: 32,
                  paddingInline: 2,
                  borderRadius: '4px',
                  cursor: 'pointer',
                  backgroundColor: name === current ? tokens['action.primary.tint'] : undefined,
                  '&:hover': { backgroundColor: tokens['bg.muted'] },
                }}
              >
                <Box
                  component="code"
                  sx={{ fontFamily: 'var(--hd-font-mono, monospace)', fontSize: 12 }}
                >
                  <bdi>{`{{${name}}}`}</bdi>
                </Box>
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                  <bdi>{samples.get(name) ?? ''}</bdi>
                </Typography>
              </Box>
            ))}
          </Box>
        ))}
      </Box>
      <Typography variant="caption" sx={{ color: 'text.secondary' }}>
        {t('macros:editor.placeholders.hint')}
      </Typography>
    </Paper>
  );
}
