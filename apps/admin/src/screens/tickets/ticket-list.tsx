import type { Department, TagSummary, Ticket, TicketStatus } from '@helpdock/schemas';
import { Box, Button, Checkbox, Chip, InputAdornment, TextField, Typography } from '@mui/material';
import { ListFilter, Search, TicketIcon } from 'lucide-react';
import { type ReactNode, type RefObject, useEffect, useId, useRef, useState } from 'react';
import { useT } from '../../app/i18n.js';
import { useSemanticTokens } from '../../app/tokens.js';
import { useAriaKeyShortcuts } from '../../keyboard/keyboard-provider.tsx';
import type { ShortcutId } from '../../keyboard/registry.js';
import { ShortcutHints } from '../../keyboard/shortcut-hints.tsx';
import { CountBadge } from '../../shell/count-badge.tsx';
import { EmptyState } from '../../shell/empty-state.tsx';
import type { HeaderState } from '../../tickets/selection.js';
import { activeFilterCount, type EmptyKind, type WorkspaceFilters } from '../../tickets/views.js';
import { visuallyHidden } from '../../ui/visually-hidden.js';
import { FilterPopover } from './filter-popover.tsx';
import { useFilterSummary } from './filter-summary.js';
import { MenuTriggerTooltip } from './menu-trigger-tooltip.tsx';
import { SortMenu } from './sort-menu.tsx';
import { TicketRow } from './ticket-row.tsx';
import { TicketListSkeleton } from './ticket-skeletons.tsx';

/**
 * The 360 px list column of DESIGN §6.5: a heading naming the view, the search
 * field, the Filter button, and the rows.
 *
 * On a saved view whose filters somebody changed, the header grows the
 * "Filters changed · Reset · Save as new · Save" bar of `Admin/View-Dialogs`
 * panel 4, and every filter that is on is a chip that removes itself (M1-05).
 *
 * Paging is a **"Load more" button rather than a virtualised window**. The
 * index that makes 50 k tickets fast is the keyset cursor, not the renderer;
 * a virtualiser would be a dependency outside the stack table (ARCHITECTURE §1)
 * solving a problem a page of twenty-five rows does not have. When a desk
 * genuinely scrolls thousands of rows, that is the moment for an ADR.
 */

export const TICKET_LIST_WIDTH = 360;

/**
 * What the list needs to draw ticking (M14-04): which rows are ticked, the
 * header checkbox, and the bar that appears while anything is. `undefined` for
 * a reader who cannot change tickets, who gets the list as it was.
 */
export interface ListSelection {
  readonly ids: ReadonlySet<string>;
  readonly header: HeaderState;
  /** The last tick wanted more than the cap and took what fit. */
  readonly capped: boolean;
  /** The max a bulk edit may name, for the caption. */
  readonly max: number;
  /** The header checkbox, so focus can come back to the list when the bar goes. */
  readonly headerRef: RefObject<HTMLInputElement | null>;
  /** What a screen reader hears when the count changes: "3 tickets selected". */
  readonly announcement: string;
  /** The bulk bar; null while nothing is ticked. */
  readonly bar: ReactNode;
  onSelect(ticketId: string, range: boolean): void;
  onSelectPage(): void;
}

const EMPTY_COPY = {
  search: { heading: 'tickets:empty.searchHeading', body: 'tickets:empty.searchBody' },
  myOpen: { heading: 'tickets:empty.myOpenHeading', body: 'tickets:empty.myOpenBody' },
  unassigned: { heading: 'tickets:empty.unassignedHeading', body: 'tickets:empty.unassignedBody' },
  overdue: { heading: 'tickets:empty.overdueHeading', body: 'tickets:empty.overdueBody' },
  filtered: { heading: 'tickets:empty.filteredHeading', body: 'tickets:empty.filteredBody' },
  plain: { heading: 'tickets:empty.listHeading', body: 'tickets:empty.listBody' },
} as const satisfies Record<EmptyKind, { heading: string; body: string }>;

const EMPTY_HINTS = [
  'general.newTicket',
  'goTo.unassigned',
  'general.shortcuts',
] as const satisfies readonly ShortcutId[];

export function TicketList({
  heading,
  tickets,
  selectedId,
  now,
  search,
  emptyKind,
  typed,
  filters,
  statuses,
  departments,
  tags,
  staff,
  viewerId,
  changes,
  openFiltersToken,
  focusSearchToken = null,
  hasMore,
  loading,
  failed,
  linkSearch,
  selection,
  onTypedChange,
  onFiltersChange,
  onLoadMore,
  onRetry,
  onNewTicket,
}: {
  readonly heading: string;
  readonly tickets: readonly Ticket[];
  readonly selectedId: string | null;
  readonly now: number;
  /** The term the list was read with, which decides which empty state shows. */
  readonly search: string;
  /** Which words the empty list says (M14-06). */
  readonly emptyKind: EmptyKind;
  /** The term in the box, which is ahead of it while somebody is typing. */
  readonly typed: string;
  readonly filters: WorkspaceFilters;
  readonly statuses: readonly TicketStatus[];
  readonly departments: readonly Department[];
  readonly tags: readonly TagSummary[];
  readonly staff: readonly { readonly userId: string; readonly name: string }[];
  readonly viewerId: string;
  /**
   * Set when the list is a saved view whose filters the URL has replaced with
   * different ones: what the bar offers. `canSave` is false for a view the
   * reader may not change and for a built-in, whose filters never change.
   */
  readonly changes: {
    readonly canSave: boolean;
    onReset(): void;
    onSave(): void;
    onSaveAsNew(): void;
  } | null;
  /** Changes whenever something outside asks for the filters to open ("Edit filters"). */
  readonly openFiltersToken: number | null;
  /** Changes whenever `/` asks for the search box (M14-01). */
  readonly focusSearchToken?: number | null;
  readonly hasMore: boolean;
  readonly loading: boolean;
  readonly failed: boolean;
  readonly linkSearch: string;
  /** M14-04. */
  readonly selection?: ListSelection | undefined;
  onTypedChange(value: string): void;
  onFiltersChange(filters: WorkspaceFilters): void;
  onLoadMore(): void;
  onRetry(): void;
  onNewTicket(): void;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const searchId = useId();
  const filterButton = useRef<HTMLButtonElement | null>(null);
  const searchInput = useRef<HTMLInputElement | null>(null);
  const newTicketKeys = useAriaKeyShortcuts('general.newTicket');
  const searchKeys = useAriaKeyShortcuts('general.search');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const active = activeFilterCount(filters);
  const filterLabel =
    active === 0 ? t('tickets:list.filter') : t('tickets:list.filterActive', { count: active });
  const summary = useFilterSummary({ statuses, departments, tags, staff });
  const chips = summary.chips(filters);

  const emptyAction =
    emptyKind === 'search' ? (
      <Button
        variant="outlined"
        onClick={() => {
          onTypedChange('');
        }}
      >
        {t('tickets:empty.clearSearch')}
      </Button>
    ) : emptyKind === 'filtered' ? (
      <Button variant="outlined" onClick={() => setFiltersOpen(true)}>
        {t('tickets:empty.editFilters')}
      </Button>
    ) : undefined;

  useEffect(() => {
    if (openFiltersToken !== null) {
      setFiltersOpen(true);
    }
  }, [openFiltersToken]);

  useEffect(() => {
    if (focusSearchToken !== null) {
      searchInput.current?.focus();
    }
  }, [focusSearchToken]);

  return (
    <Box
      component="section"
      aria-label={t('tickets:list.label')}
      sx={{
        width: { xs: '100%', md: TICKET_LIST_WIDTH },
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        position: 'relative',
        backgroundColor: tokens['bg.surface'],
        borderInlineEnd: `1px solid ${tokens['border.default']}`,
      }}
    >
      <Box sx={{ padding: 4, display: 'flex', flexDirection: 'column', gap: 3 }}>
        <Box
          sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 3 }}
        >
          <Typography variant="h3" component="h1" noWrap sx={{ minWidth: 0 }}>
            {heading}
          </Typography>
          <Box sx={{ display: 'flex', gap: 2, alignItems: 'center', flexShrink: 0 }}>
            <SortMenu filters={filters} onChange={onFiltersChange} />
            <MenuTriggerTooltip title={filterLabel} menuOpen={filtersOpen}>
              <Button
                ref={filterButton}
                variant="outlined"
                size="small"
                aria-label={filterLabel}
                sx={{ minWidth: 28, width: 28, padding: 0, flexShrink: 0, overflow: 'visible' }}
                aria-expanded={filtersOpen}
                aria-haspopup="dialog"
                onClick={() => setFiltersOpen(true)}
              >
                <ListFilter size={14} aria-hidden="true" />
                {active > 0 ? <CountBadge count={active} offset={-6} /> : null}
              </Button>
            </MenuTriggerTooltip>
            <Button
              variant="contained"
              size="small"
              sx={{ whiteSpace: 'nowrap', flexShrink: 0 }}
              aria-keyshortcuts={newTicketKeys}
              onClick={onNewTicket}
            >
              {t('tickets:newTicket.action')}
            </Button>
          </Box>
        </Box>

        {changes === null ? null : (
          <Box
            role="status"
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 2,
              paddingBlock: 1,
              paddingInline: 3,
              borderRadius: '6px',
              backgroundColor: tokens['status.warning.tint'],
              color: tokens['status.warning.text'],
            }}
          >
            <Typography variant="caption" sx={{ flex: 1, color: 'inherit' }}>
              {t('tickets:viewBar.changed')}
            </Typography>
            <Button size="small" variant="text" color="inherit" onClick={changes.onReset}>
              {t('tickets:viewBar.reset')}
            </Button>
            <Button size="small" variant="outlined" onClick={changes.onSaveAsNew}>
              {t('tickets:viewBar.saveAsNew')}
            </Button>
            {changes.canSave ? (
              <Button size="small" variant="contained" onClick={changes.onSave}>
                {t('tickets:viewBar.save')}
              </Button>
            ) : null}
          </Box>
        )}

        {chips.length === 0 ? null : (
          <Box
            component="ul"
            aria-label={t('tickets:viewBar.chips')}
            sx={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 2,
              margin: 0,
              padding: 0,
              listStyle: 'none',
            }}
          >
            {chips.map((chip) => (
              <Box component="li" key={chip.key}>
                <Chip
                  size="small"
                  label={chip.label}
                  // The whole chip removes itself, not only its ×: it is one
                  // control with one name, and Enter on it should do the same.
                  onClick={() => {
                    onFiltersChange(chip.without);
                  }}
                  onDelete={() => {
                    onFiltersChange(chip.without);
                  }}
                  slotProps={{
                    root: { 'aria-label': t('tickets:viewBar.remove', { filter: chip.label }) },
                  }}
                />
              </Box>
            ))}
          </Box>
        )}

        <TextField
          id={searchId}
          inputRef={searchInput}
          size="small"
          type="search"
          value={typed}
          placeholder={t('tickets:list.searchPlaceholder')}
          onChange={(event) => {
            onTypedChange(event.target.value);
          }}
          slotProps={{
            htmlInput: {
              'aria-label': t('tickets:list.searchLabel'),
              'aria-keyshortcuts': searchKeys,
            },
            input: {
              sx: { height: 32 },
              startAdornment: (
                <InputAdornment position="start">
                  <Search size={16} aria-hidden="true" />
                </InputAdornment>
              ),
            },
          }}
        />
      </Box>

      <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto' }} aria-busy={loading}>
        {failed ? (
          <EmptyState
            icon={TicketIcon}
            heading={t('tickets:error.listHeading')}
            body={t('tickets:error.listBody')}
            action={
              <Button variant="outlined" onClick={onRetry}>
                {t('tickets:error.retry')}
              </Button>
            }
          />
        ) : tickets.length === 0 && loading ? (
          <TicketListSkeleton />
        ) : tickets.length === 0 ? (
          <EmptyState
            icon={TicketIcon}
            heading={t(EMPTY_COPY[emptyKind].heading, { term: search })}
            body={t(EMPTY_COPY[emptyKind].body)}
            action={emptyAction}
            hints={<ShortcutHints ids={EMPTY_HINTS} fallbackFocus={() => searchInput.current} />}
          />
        ) : (
          <>
            {selection === undefined ? null : (
              <SelectionHeader selection={selection} loaded={tickets.length} />
            )}
            <Box component="ul" sx={{ margin: 0, padding: 0 }}>
              {tickets.map((ticket) => (
                <TicketRow
                  key={ticket.id}
                  ticket={ticket}
                  selected={ticket.id === selectedId}
                  now={now}
                  search={linkSearch}
                  selection={
                    selection === undefined
                      ? undefined
                      : {
                          checked: selection.ids.has(ticket.id),
                          onSelect: (range) => {
                            selection.onSelect(ticket.id, range);
                          },
                        }
                  }
                />
              ))}
            </Box>

            {hasMore ? (
              <Box sx={{ padding: 4, display: 'flex', justifyContent: 'center' }}>
                <Button variant="text" size="small" onClick={onLoadMore} disabled={loading}>
                  {t('tickets:list.loadMore')}
                </Button>
              </Box>
            ) : null}
          </>
        )}
      </Box>

      {selection?.bar == null ? null : (
        // The list's footer: always inside the column, so it never covers the open ticket.
        <Box sx={{ padding: 3, borderBlockStart: `1px solid ${tokens['border.default']}` }}>
          {selection.bar}
        </Box>
      )}

      <FilterPopover
        anchorEl={filtersOpen ? filterButton.current : null}
        filters={filters}
        statuses={statuses}
        departments={departments}
        tags={tags}
        staff={staff}
        viewerId={viewerId}
        onChange={onFiltersChange}
        onClose={() => {
          setFiltersOpen(false);
        }}
      />
    </Box>
  );
}

/**
 * The header of the rows (`Admin/Tickets-Bulk`): a checkbox that selects the
 * loaded page — indeterminate when only some are ticked — and a caption with
 * the count and the cap. The caption is a polite live region, so ticking with
 * the keyboard says "3 tickets selected" without moving focus.
 */
function SelectionHeader({
  selection,
  loaded,
}: {
  readonly selection: ListSelection;
  readonly loaded: number;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const count = selection.ids.size;

  // MUI marks a mixed box with `aria-checked="mixed"` and leaves the native
  // `indeterminate` property alone, which a native checkbox must agree with.
  useEffect(() => {
    if (selection.headerRef.current !== null) {
      selection.headerRef.current.indeterminate = selection.header === 'some';
    }
  }, [selection.header, selection.headerRef]);

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        height: 36,
        paddingInlineStart: '3px',
        borderBlockEnd: `1px solid ${tokens['border.default']}`,
        color: 'text.secondary',
      }}
    >
      <Checkbox
        size="small"
        checked={selection.header === 'all'}
        indeterminate={selection.header === 'some'}
        onChange={selection.onSelectPage}
        slotProps={{
          input: { ref: selection.headerRef, 'aria-label': t('tickets:bulk.selectAll') },
        }}
        sx={{ padding: 1, marginInlineStart: 2, flexShrink: 0 }}
      />
      <Typography variant="caption" sx={{ marginInlineStart: 3 }}>
        {count === 0
          ? t('tickets:bulk.headerNone')
          : t(selection.capped ? 'tickets:bulk.headerCapped' : 'tickets:bulk.headerCaption', {
              selected: count,
              loaded,
              max: selection.max,
            })}
      </Typography>
      <Box component="span" aria-live="polite" aria-atomic="true" sx={visuallyHidden}>
        {selection.announcement}
      </Box>
    </Box>
  );
}
