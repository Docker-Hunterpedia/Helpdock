import type { AssignableAgent } from '@helpdock/schemas';
import { Box, Button, MenuItem, MenuList, Popover, TextField, Typography } from '@mui/material';
import { ChevronDown } from 'lucide-react';
import { type ReactNode, useId, useRef, useState } from 'react';
import { useT } from '../../app/i18n.js';
import { useSemanticTokens } from '../../app/tokens.js';
import { PresenceDot } from '../../ui/presence-dot.tsx';

/**
 * The assignee picker of the details panel (`AdminTicketDialogs`, panel 3,
 * M1-07): DESIGN §6.1's Combobox — a search over a listbox — drawn in the
 * Menu overlay of §6.4.
 *
 * Each option carries the three things a person chooses an assignee by:
 * whether they are around (the presence dot, with the word "offline" where a
 * count would be), and how loaded they are against the department's cap. An
 * agent at cap is still offered — the rotation skips them, a person may not —
 * and says so in danger.
 */

/** Case-insensitive, and on the whole name, because people search by surname too. */
export const matchesSearch = (name: string, term: string): boolean =>
  name.toLocaleLowerCase().includes(term.trim().toLocaleLowerCase());

export function AssigneePicker({
  id,
  label,
  assigneeId,
  assigneeName,
  agents,
  loadCap,
  departmentName,
  unavailable,
  busy,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly assigneeId: string | null;
  /** What the button says; resolved by the caller, which knows every source of names. */
  readonly assigneeName: string | null;
  readonly agents: readonly AssignableAgent[];
  readonly loadCap: number | null;
  readonly departmentName: string;
  /** The read failed: the list says so rather than looking empty. */
  readonly unavailable: boolean;
  readonly busy: boolean;
  onChange(assigneeId: string | null): void;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const listId = useId();
  const listRef = useRef<HTMLUListElement>(null);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [term, setTerm] = useState('');

  const shown = agents.filter((agent) => matchesSearch(agent.name, term));
  const current = assigneeName ?? t('tickets:details.unassigned');

  const close = (): void => {
    setAnchor(null);
    setTerm('');
  };

  const choose = (next: string | null): void => {
    close();
    if (next !== assigneeId) {
      onChange(next);
    }
  };

  const load = (agent: AssignableAgent): ReactNode => {
    if (agent.presence === 'offline') {
      return (
        <Typography variant="caption" component="span" sx={{ color: 'text.secondary' }}>
          {t('tickets:details.picker.offline')}
        </Typography>
      );
    }

    const full = loadCap !== null && agent.openCount >= loadCap;

    return (
      <Typography
        variant="mono"
        component="span"
        sx={{
          fontSize: 12,
          color: full ? tokens['status.danger.text'] : tokens['text.secondary'],
        }}
      >
        {loadCap === null
          ? agent.openCount
          : t(full ? 'tickets:details.picker.atCap' : 'tickets:details.picker.load', {
              open: agent.openCount,
              cap: loadCap,
            })}
      </Typography>
    );
  };

  return (
    <Box>
      <Typography
        variant="caption"
        component="span"
        sx={{ display: 'block', color: 'text.secondary', marginBlockEnd: 1 }}
      >
        {label}
      </Typography>
      <Button
        id={id}
        variant="outlined"
        fullWidth
        disabled={busy}
        aria-haspopup="listbox"
        aria-expanded={anchor !== null}
        aria-controls={anchor === null ? undefined : listId}
        aria-label={t('tickets:details.picker.open', { name: current })}
        endIcon={<ChevronDown size={16} aria-hidden="true" />}
        onClick={(event) => {
          setAnchor(event.currentTarget);
        }}
        sx={{
          justifyContent: 'space-between',
          color: 'text.primary',
          borderColor: tokens['border.strong'],
          fontWeight: 400,
        }}
      >
        <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {current}
        </Box>
      </Button>

      <Popover
        open={anchor !== null}
        anchorEl={anchor}
        onClose={close}
        // Centred, as the filter popover is, so it needs no mirroring in RTL.
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        transformOrigin={{ vertical: 'top', horizontal: 'center' }}
        slotProps={{ paper: { sx: { inlineSize: 300, padding: 2 } } }}
      >
        <TextField
          type="search"
          size="small"
          fullWidth
          autoFocus
          value={term}
          placeholder={t('tickets:details.picker.search')}
          onChange={(event) => {
            setTerm(event.target.value);
          }}
          onKeyDown={(event) => {
            // Into the list, the way a combobox's arrow key goes.
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              listRef.current?.querySelector<HTMLElement>('[role="option"]')?.focus();
            }
          }}
          slotProps={{
            htmlInput: {
              'aria-label': t('tickets:details.picker.search'),
              'aria-controls': listId,
            },
          }}
          sx={{ marginBlockEnd: 2 }}
        />

        <MenuList
          id={listId}
          ref={listRef}
          role="listbox"
          aria-label={t('tickets:details.picker.list')}
          dense
          sx={{ padding: 0 }}
        >
          <MenuItem
            role="option"
            aria-selected={assigneeId === null}
            selected={assigneeId === null}
            onClick={() => {
              choose(null);
            }}
          >
            {t('tickets:details.unassigned')}
          </MenuItem>
          {shown.map((agent) => (
            <MenuItem
              key={agent.userId}
              role="option"
              aria-selected={agent.userId === assigneeId}
              selected={agent.userId === assigneeId}
              onClick={() => {
                choose(agent.userId);
              }}
              sx={{ gap: 2 }}
            >
              <PresenceDot status={agent.presence} />
              <Box
                component="span"
                sx={{
                  flexGrow: 1,
                  fontWeight: agent.userId === assigneeId ? 500 : 400,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {agent.name}
              </Box>
              {load(agent)}
            </MenuItem>
          ))}
          {shown.length === 0 ? (
            <MenuItem role="option" aria-disabled="true" disabled>
              {unavailable
                ? t('tickets:details.picker.unavailable')
                : t('tickets:details.picker.noMatch')}
            </MenuItem>
          ) : null}
        </MenuList>

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
          {t('tickets:details.picker.footer', { department: departmentName })}
        </Typography>
      </Popover>
    </Box>
  );
}
