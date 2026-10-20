import { Box, Button, ListSubheader, Menu, MenuItem, Tooltip, Typography } from '@mui/material';
import { ArrowDownUp, Check } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { useT } from '../../app/i18n.js';
import type { WorkspaceFilters } from '../../tickets/views.js';
import { SORT_CHOICES, sortChoice, withSortChoice } from '../admin/ticketing/view-draft.js';

const MENU_LABELS = {
  'updatedAt:desc': 'tickets:sort.menu.updatedAt',
  'createdAt:desc': 'tickets:sort.menu.createdNewest',
  'createdAt:asc': 'tickets:sort.menu.createdOldest',
  'priority:desc': 'tickets:sort.menu.priority',
  'slaDue:asc': 'tickets:sort.menu.slaDue',
} as const;

/** Admin/Tickets-SortSla: changing order starts a fresh list through its URL. */
export function SortMenu({
  filters,
  onChange,
}: {
  readonly filters: WorkspaceFilters;
  onChange(filters: WorkspaceFilters): void;
}): ReactNode {
  const t = useT();
  const id = useId();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);

  return (
    <>
      <Tooltip title={t('tickets:sort.action')} describeChild>
        <Button
          id={id}
          variant="outlined"
          size="small"
          aria-label={t('tickets:sort.action')}
          sx={{ minWidth: 28, width: 28, padding: 0, flexShrink: 0 }}
          aria-haspopup="menu"
          aria-expanded={anchor !== null}
          aria-controls={anchor === null ? undefined : `${id}-menu`}
          onClick={(event) => setAnchor(event.currentTarget)}
        >
          <ArrowDownUp size={14} aria-hidden="true" />
        </Button>
      </Tooltip>
      <Menu
        id={`${id}-menu`}
        anchorEl={anchor}
        open={anchor !== null}
        onClose={() => setAnchor(null)}
        slotProps={{ list: { 'aria-labelledby': id }, paper: { sx: { width: 300 } } }}
      >
        <ListSubheader
          role="presentation"
          sx={{ typography: 'caption', px: 3, py: 2, color: 'text.secondary' }}
        >
          {t('tickets:sort.label')}
        </ListSubheader>
        {SORT_CHOICES.map((choice) => {
          const selected = sortChoice(filters) === choice;
          return (
            <MenuItem
              key={choice}
              role="menuitemradio"
              aria-checked={selected}
              selected={selected}
              onClick={() => {
                onChange(withSortChoice(filters, choice));
                setAnchor(null);
              }}
              sx={{ gap: 3 }}
            >
              <Box sx={{ flexGrow: 1 }}>
                <Typography variant="body2">{t(MENU_LABELS[choice])}</Typography>
                {choice === 'slaDue:asc' ? (
                  <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                    {t('tickets:sort.slaDue.hint')}
                  </Typography>
                ) : null}
              </Box>
              {selected ? <Check size={14} aria-hidden="true" /> : null}
            </MenuItem>
          );
        })}
      </Menu>
    </>
  );
}
