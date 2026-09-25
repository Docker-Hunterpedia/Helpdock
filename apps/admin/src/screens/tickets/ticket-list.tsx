import type { Department, TagSummary, Ticket, TicketStatus } from '@helpdock/schemas';
import { Box, Button, Chip, InputAdornment, TextField, Typography } from '@mui/material';
import { ListFilter, Search, TicketIcon } from 'lucide-react';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { useT } from '../../app/i18n.js';
import { useSemanticTokens } from '../../app/tokens.js';
import { EmptyState } from '../../shell/empty-state.tsx';
import { activeFilterCount, type WorkspaceFilters } from '../../tickets/views.js';
import { FilterPopover } from './filter-popover.tsx';
import { useFilterSummary } from './filter-summary.js';
import { TicketRow } from './ticket-row.tsx';

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

export function TicketList({
  heading,
  tickets,
  selectedId,
  now,
  search,
  typed,
  filters,
  statuses,
  departments,
  tags,
  staff,
  viewerId,
  changes,
  openFiltersToken,
  hasMore,
  loading,
  failed,
  linkSearch,
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
  readonly hasMore: boolean;
  readonly loading: boolean;
  readonly failed: boolean;
  readonly linkSearch: string;
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
  const [filtersOpen, setFiltersOpen] = useState(false);
  const active = activeFilterCount(filters);
  const summary = useFilterSummary({ statuses, departments, tags, staff });
  const chips = summary.chips(filters);

  useEffect(() => {
    if (openFiltersToken !== null) {
      setFiltersOpen(true);
    }
  }, [openFiltersToken]);

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
        backgroundColor: tokens['bg.surface'],
        borderInlineEnd: `1px solid ${tokens['border.default']}`,
      }}
    >
      <Box sx={{ padding: 4, display: 'flex', flexDirection: 'column', gap: 3 }}>
        <Box
          sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 3 }}
        >
          <Typography variant="h2" component="h1" sx={{ fontSize: 16 }}>
            {heading}
          </Typography>
          <Box sx={{ display: 'flex', gap: 2, alignItems: 'center' }}>
            <Button
              ref={filterButton}
              variant="outlined"
              size="small"
              startIcon={<ListFilter size={14} aria-hidden="true" />}
              aria-expanded={filtersOpen}
              aria-haspopup="dialog"
              onClick={() => {
                setFiltersOpen(true);
              }}
            >
              {active === 0
                ? t('tickets:list.filter')
                : t('tickets:list.filterActive', { count: active })}
            </Button>
            <Button variant="contained" size="small" onClick={onNewTicket}>
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
          size="small"
          type="search"
          value={typed}
          placeholder={t('tickets:list.searchPlaceholder')}
          onChange={(event) => {
            onTypedChange(event.target.value);
          }}
          slotProps={{
            htmlInput: { 'aria-label': t('tickets:list.searchLabel') },
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

      <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
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
        ) : tickets.length === 0 && !loading ? (
          <EmptyState
            icon={TicketIcon}
            heading={t(search === '' ? 'tickets:empty.listHeading' : 'tickets:empty.searchHeading')}
            body={t(search === '' ? 'tickets:empty.listBody' : 'tickets:empty.searchBody')}
          />
        ) : (
          <>
            <Box component="ul" sx={{ margin: 0, padding: 0 }}>
              {tickets.map((ticket) => (
                <TicketRow
                  key={ticket.id}
                  ticket={ticket}
                  selected={ticket.id === selectedId}
                  now={now}
                  search={linkSearch}
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
