import type { AssignableAgent } from '@helpdock/schemas';
import { Box, Button, MenuItem, MenuList, Popover, TextField, Typography } from '@mui/material';
import { ChevronDown } from 'lucide-react';
import { type ReactNode, type Ref, useId, useRef, useState } from 'react';
import { useT } from '../../app/i18n.js';
import { useSemanticTokens } from '../../app/tokens.js';
import { useAriaKeyShortcuts } from '../../keyboard/keyboard-provider.tsx';
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
 *
 * The popover is its own component, {@link AssigneePopover}, because the bulk
 * bar (M14-04) opens the very same picker from its Assign button.
 */

/** Case-insensitive, and on the whole name, because people search by surname too. */
export const matchesSearch = (name: string, term: string): boolean =>
  name.toLowerCase().includes(term.trim().toLowerCase());

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
  buttonRef,
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
  /** The button, so `a` can open the picker (M14-01). */
  readonly buttonRef?: Ref<HTMLButtonElement> | undefined;
  onChange(assigneeId: string | null): void;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const listId = useId();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const keyShortcuts = useAriaKeyShortcuts('ticket.assignee');

  const current = assigneeName ?? t('tickets:details.unassigned');

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
        ref={buttonRef}
        variant="outlined"
        fullWidth
        disabled={busy}
        aria-keyshortcuts={keyShortcuts}
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

      <AssigneePopover
        anchor={anchor}
        listId={listId}
        selectedId={assigneeId}
        agents={agents}
        loadCap={loadCap}
        unavailable={unavailable}
        footer={t('tickets:details.picker.footer', { department: departmentName })}
        onClose={() => {
          setAnchor(null);
        }}
        onChoose={(next) => {
          if (next !== assigneeId) {
            onChange(next);
          }
        }}
      />
    </Box>
  );
}

/**
 * The search and the listbox of people. `leading` holds options that come
 * before "Unassigned" (the bulk bar's "Assign to me"), each a `role="option"`
 * `MenuItem` of the caller's.
 */
export function AssigneePopover({
  anchor,
  listId,
  selectedId,
  agents,
  loadCap,
  unavailable,
  footer,
  leading,
  onClose,
  onChoose,
}: {
  readonly anchor: HTMLElement | null;
  readonly listId: string;
  /** The person already assigned, ticked in the list; `undefined` when several differ. */
  readonly selectedId: string | null | undefined;
  readonly agents: readonly AssignableAgent[];
  readonly loadCap: number | null;
  readonly unavailable: boolean;
  readonly footer: string;
  readonly leading?: (choose: (next: string | null) => void) => ReactNode;
  onClose(): void;
  onChoose(assigneeId: string | null): void;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const listRef = useRef<HTMLUListElement>(null);
  const [term, setTerm] = useState('');

  const shown = agents.filter((agent) => matchesSearch(agent.name, term));

  const close = (): void => {
    onClose();
    setTerm('');
  };

  const choose = (next: string | null): void => {
    close();
    onChoose(next);
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
        {leading?.(choose)}
        <MenuItem
          role="option"
          aria-selected={selectedId === null}
          selected={selectedId === null}
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
            aria-selected={agent.userId === selectedId}
            selected={agent.userId === selectedId}
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
                fontWeight: agent.userId === selectedId ? 500 : 400,
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
        {footer}
      </Typography>
    </Popover>
  );
}
