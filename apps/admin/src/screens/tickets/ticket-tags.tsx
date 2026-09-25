import type { Tag, TagSummary } from '@helpdock/schemas';
import { Box, Button, Popover, TextField, Typography } from '@mui/material';
import { Check, Plus } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useId, useState } from 'react';
import { useT } from '../../app/i18n.js';
import { usePreferences } from '../../app/providers.tsx';
import { useSemanticTokens } from '../../app/tokens.js';
import { tagLabel, tagMatches, toggleTag } from '../../tickets/tags.js';
import { TagChip } from '../admin/ticketing/tag-chip.tsx';
import { tagTint } from '../admin/ticketing/tag-colours.js';

/**
 * The details panel's tags row and its picker (`AdminTicketTags`, panels 1
 * and 2; M1-15).
 *
 * The row is the ticket's chips, each with a × that takes it off at once, and
 * an Add button. The picker is DESIGN §6.1's multi-select Combobox: the
 * brand's tags filtered as you type, ticked where the ticket carries them.
 * Every pick is a whole new set handed to `onChange`, because that is what the
 * api's replace takes; the caller saves it and draws it before the answer.
 *
 * The picker never creates a tag. What a brand labels its tickets with is
 * configuration (`ticketing:manage`), and a typo here would become a tag every
 * agent then has to scroll past; the empty state says where tags are made.
 *
 * A Viewer, or anybody else without `ticket:write`, gets the chips and nothing
 * to press.
 */
export function TicketTags({
  tags,
  brandTags,
  canWrite,
  onChange,
}: {
  /** What the ticket carries now, as drawn (optimistically, while a save is out). */
  readonly tags: readonly Tag[];
  readonly brandTags: readonly TagSummary[];
  readonly canWrite: boolean;
  onChange(tagIds: string[]): void;
}): ReactNode {
  const t = useT();
  const { locale } = usePreferences();
  const headingId = useId();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);

  const held = tags.map((tag) => tag.id);

  return (
    <Box component="section" aria-labelledby={headingId}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        <Typography
          id={headingId}
          variant="caption"
          component="h2"
          sx={{ flexGrow: 1, color: 'text.secondary' }}
        >
          {t('tickets:details.tags')}
        </Typography>
        {canWrite ? (
          <Button
            variant="outlined"
            size="small"
            aria-label={t('tickets:details.tagPicker.open')}
            aria-haspopup="listbox"
            aria-expanded={anchor !== null}
            startIcon={<Plus size={12} aria-hidden="true" />}
            onClick={(event) => {
              setAnchor(event.currentTarget);
            }}
          >
            {t('tickets:details.tagPicker.add')}
          </Button>
        ) : null}
      </Box>

      {tags.length === 0 ? (
        <Typography variant="body2" sx={{ marginBlockStart: 2, color: 'text.secondary' }}>
          {t('tickets:details.noTags')}
        </Typography>
      ) : (
        <Box
          component="ul"
          sx={{
            listStyle: 'none',
            margin: 0,
            padding: 0,
            marginBlockStart: 2,
            display: 'flex',
            flexWrap: 'wrap',
            columnGap: 2,
            // The × targets overhang their chips by 3 px, so a wrapped row keeps ≥ 8 px between them (DESIGN §10).
            rowGap: 4,
          }}
        >
          {tags.map((tag) => (
            <Box component="li" key={tag.id}>
              {canWrite ? (
                <TagChip
                  tag={tag}
                  removeLabel={t('tickets:details.tagPicker.remove', {
                    name: tagLabel(tag, locale),
                  })}
                  onRemove={() => {
                    onChange(held.filter((id) => id !== tag.id));
                  }}
                />
              ) : (
                <TagChip tag={tag} />
              )}
            </Box>
          ))}
        </Box>
      )}

      <Popover
        open={anchor !== null}
        anchorEl={anchor}
        onClose={() => {
          setAnchor(null);
        }}
        // Centred, as the assignee picker is, so it needs no mirroring in RTL.
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        transformOrigin={{ vertical: 'top', horizontal: 'center' }}
        slotProps={{ paper: { sx: { inlineSize: 300, padding: 2 } } }}
      >
        <TagPicker
          held={held}
          brandTags={brandTags}
          onToggle={(tagId) => {
            onChange(toggleTag(held, tagId));
          }}
        />
      </Popover>
    </Box>
  );
}

/**
 * The Combobox itself. Focus stays in the search field and the active option
 * is `aria-activedescendant`, the WAI-ARIA combobox pattern: ↑/↓ move it,
 * Enter toggles it, Esc closes the popover (MUI's `onClose`).
 */
function TagPicker({
  held,
  brandTags,
  onToggle,
}: {
  readonly held: readonly string[];
  readonly brandTags: readonly TagSummary[];
  onToggle(tagId: string): void;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const { locale } = usePreferences();
  const listId = useId();
  const [term, setTerm] = useState('');
  const [active, setActive] = useState(0);

  const shown = brandTags.filter((tag) => tagMatches(tag, term));
  const current = shown[Math.min(active, shown.length - 1)];
  const optionId = (tagId: string): string => `${listId}-${tagId}`;

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive((index) => Math.max(0, Math.min(shown.length - 1, index + step)));
    }
    if (event.key === 'Enter' && current !== undefined) {
      event.preventDefault();
      onToggle(current.id);
    }
  };

  return (
    <>
      <TextField
        type="search"
        size="small"
        fullWidth
        autoFocus
        value={term}
        placeholder={t('tickets:details.tagPicker.search')}
        onChange={(event) => {
          setTerm(event.target.value);
          setActive(0);
        }}
        onKeyDown={onKeyDown}
        slotProps={{
          htmlInput: {
            role: 'combobox',
            'aria-label': t('tickets:details.tagPicker.search'),
            'aria-expanded': true,
            'aria-controls': listId,
            'aria-autocomplete': 'list',
            'aria-activedescendant': current === undefined ? undefined : optionId(current.id),
          },
        }}
        sx={{ marginBlockEnd: 2 }}
      />

      {shown.length === 0 ? (
        <Typography variant="body2" sx={{ padding: 2, color: 'text.secondary' }}>
          {brandTags.length === 0
            ? t('tickets:details.tagPicker.none')
            : t('tickets:details.tagPicker.noMatch', { term: term.trim() })}
        </Typography>
      ) : (
        <Box
          component="ul"
          id={listId}
          role="listbox"
          aria-multiselectable="true"
          aria-label={t('tickets:details.tagPicker.list')}
          sx={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: '2px' }}
        >
          {shown.map((tag) => {
            const selected = held.includes(tag.id);
            const tint = tagTint(tag.color, tokens);

            return (
              <Box
                component="li"
                key={tag.id}
                id={optionId(tag.id)}
                role="option"
                aria-selected={selected}
                // Keeps focus in the search field, which owns the keyboard.
                onMouseDown={(event) => {
                  event.preventDefault();
                }}
                onClick={() => {
                  onToggle(tag.id);
                }}
                sx={{
                  blockSize: 32,
                  paddingInline: 2,
                  borderRadius: '6px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 2,
                  cursor: 'pointer',
                  fontSize: 13,
                  backgroundColor: tag.id === current?.id ? tokens['bg.muted'] : 'transparent',
                }}
              >
                <Box component="span" sx={{ inlineSize: 14, display: 'inline-flex' }}>
                  {selected ? (
                    <Check size={14} aria-hidden="true" color={tokens['action.primary']} />
                  ) : null}
                </Box>
                <Box
                  component="span"
                  aria-hidden="true"
                  sx={{
                    inlineSize: 10,
                    blockSize: 10,
                    borderRadius: '4px',
                    backgroundColor: tint.background,
                    border: `1px solid ${tint.text}`,
                  }}
                />
                <Box
                  component="span"
                  lang={locale === 'ar' && tag.nameAr !== null ? 'ar' : undefined}
                  sx={{ flexGrow: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}
                >
                  {tagLabel(tag, locale)}
                </Box>
              </Box>
            );
          })}
        </Box>
      )}

      <Typography
        variant="caption"
        component="p"
        sx={{
          marginBlockStart: 1,
          paddingBlockStart: 2,
          paddingInline: 2,
          color: 'text.secondary',
          borderBlockStart: `1px solid ${tokens['border.default']}`,
        }}
      >
        {t('tickets:details.tagPicker.footer')}
      </Typography>
    </>
  );
}
