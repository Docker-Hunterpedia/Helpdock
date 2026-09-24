import { Box, Typography } from '@mui/material';
import { useQueries } from '@tanstack/react-query';
import { type ReactNode, useId } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useT } from '../../app/i18n.js';
import { ROUTES } from '../../app/route-paths.js';
import { useSemanticTokens } from '../../app/tokens.js';
import { currentBrand, useSession, useTicketsApi } from '../../auth/session.tsx';
import { ticketKeys } from '../../tickets/keys.js';
import { TICKET_VIEW_KEYS, TICKET_VIEWS, viewCount } from '../../tickets/views.js';

/**
 * The "Views" group of DESIGN §6.5: 32 px rows with a mono count.
 *
 * The counts are read from the list api rather than from a counter endpoint
 * there is no design for: each view asks for its own first page and counts what
 * comes back, and a brand with more than a page says "25+". That is honest
 * about a keyset-paged list, and it is one request per view rather than one
 * per view *plus* a total.
 *
 * M1-05 replaces the four with saved views; the group, the counts and the
 * `?view=` parameter are what it grows into, so only the source of the list
 * changes.
 */

const ALL_VIEW = 'all';
const COUNT_STALE_MS = 30_000;

export function TicketViewsNav({
  onNavigate,
}: {
  readonly onNavigate?: (() => void) | undefined;
}): ReactNode {
  const t = useT();
  const session = useSession();
  const api = useTicketsApi();
  const [params] = useSearchParams();
  const labelId = useId();
  const brand = currentBrand(session);
  const now = Date.now();
  const selected = params.get('view') ?? 'myOpen';

  const counts = useQueries({
    queries: TICKET_VIEW_KEYS.map((key) => {
      const query = TICKET_VIEWS[key].query(session.user.id);

      return {
        queryKey: ticketKeys.count(brand.id, key),
        queryFn: () => api.list(brand.id, query),
        staleTime: COUNT_STALE_MS,
      };
    }),
    combine: (results) =>
      TICKET_VIEW_KEYS.map((key, index) => {
        const list = results[index]?.data;

        return list === undefined ? null : viewCount(TICKET_VIEWS[key], list, now);
      }),
  });

  return (
    <>
      <Typography
        id={labelId}
        component="p"
        variant="caption"
        sx={{ color: 'text.secondary', paddingInline: 3, marginBlock: '16px 4px', fontSize: 11 }}
      >
        {t('tickets:views.label')}
      </Typography>

      <Box
        component="ul"
        aria-labelledby={labelId}
        sx={{ listStyle: 'none', margin: 0, padding: 0 }}
      >
        <ViewLink
          label={t('tickets:views.all')}
          to={`${ROUTES.tickets}?view=${ALL_VIEW}`}
          active={selected === ALL_VIEW}
          onNavigate={onNavigate}
        />
        {TICKET_VIEW_KEYS.map((key, index) => {
          const count = counts[index] ?? null;

          return (
            <ViewLink
              key={key}
              label={t(`tickets:views.${key}`)}
              to={`${ROUTES.tickets}?view=${key}`}
              active={selected === key}
              onNavigate={onNavigate}
              count={
                count === null
                  ? undefined
                  : count.partial
                    ? t('tickets:views.partialCount', { count: count.count })
                    : String(count.count)
              }
              // DESIGN §2.3: Overdue is the one view whose number is a warning,
              // and it is a number in the danger hue only while there is one.
              danger={key === 'overdue' && (count?.count ?? 0) > 0}
            />
          );
        })}
      </Box>
    </>
  );
}

function ViewLink({
  label,
  to,
  active,
  count,
  danger = false,
  onNavigate,
}: {
  readonly label: string;
  readonly to: string;
  readonly active: boolean;
  readonly count?: string | undefined;
  readonly danger?: boolean;
  readonly onNavigate?: (() => void) | undefined;
}): ReactNode {
  const palette = useSemanticTokens();

  return (
    <Box component="li">
      {/* A plain `Link`, not a `NavLink`: every view is the same *path* and
          differs only by query, so `NavLink` would mark all five current. The
          selected one is decided here, from the parameter. */}
      <Link
        to={to}
        onClick={onNavigate}
        aria-current={active ? 'true' : undefined}
        style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}
      >
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 3,
            height: 32,
            paddingInline: 3,
            borderRadius: '6px',
            fontWeight: active ? 500 : 400,
            backgroundColor: active ? palette['bg.muted'] : 'transparent',
            '&:hover': { backgroundColor: palette['bg.muted'] },
          }}
        >
          <Typography
            component="span"
            variant="body2"
            noWrap
            sx={{ flex: 1, fontWeight: 'inherit' }}
          >
            {label}
          </Typography>
          {count === undefined ? null : (
            <Typography
              component="span"
              variant="mono"
              sx={{ color: danger ? palette['status.danger.text'] : 'text.secondary' }}
            >
              {count}
            </Typography>
          )}
        </Box>
      </Link>
    </Box>
  );
}
