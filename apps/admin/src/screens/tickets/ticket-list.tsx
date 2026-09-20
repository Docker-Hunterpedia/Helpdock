import type { Department, Ticket, TicketStatus } from '@helpdock/schemas';
import { Box, Button, InputAdornment, TextField, Typography } from '@mui/material';
import { ListFilter, Search, TicketIcon } from 'lucide-react';
import { type ReactNode, useId, useRef, useState } from 'react';
import { useT } from '../../app/i18n.js';
import { useSemanticTokens } from '../../app/tokens.js';
import { EmptyState } from '../../shell/empty-state.tsx';
import { activeFilterCount, FilterPopover, type TicketFilters } from './filter-popover.tsx';
import { TicketRow } from './ticket-row.tsx';

/**
 * The 360 px list column of DESIGN §6.5: a heading naming the view, the search
 * field, the Filter button, and the rows.
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
  contactNames,
  selectedId,
  now,
  search,
  typed,
  filters,
  statuses,
  departments,
  staff,
  viewerId,
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
  readonly contactNames: ReadonlyMap<string, string>;
  readonly selectedId: string | null;
  readonly now: number;
  /** The term the list was read with, which decides which empty state shows. */
  readonly search: string;
  /** The term in the box, which is ahead of it while somebody is typing. */
  readonly typed: string;
  readonly filters: TicketFilters;
  readonly statuses: readonly TicketStatus[];
  readonly departments: readonly Department[];
  readonly staff: readonly { readonly userId: string; readonly name: string }[];
  readonly viewerId: string;
  readonly hasMore: boolean;
  readonly loading: boolean;
  readonly failed: boolean;
  readonly linkSearch: string;
  onTypedChange(value: string): void;
  onFiltersChange(filters: TicketFilters): void;
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
                  contactName={
                    ticket.contactId === null ? null : (contactNames.get(ticket.contactId) ?? null)
                  }
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
