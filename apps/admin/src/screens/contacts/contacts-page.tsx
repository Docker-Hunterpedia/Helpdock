import type { ContactSearchQuery } from '@helpdock/schemas';
import {
  Box,
  Button,
  Chip,
  IconButton,
  InputAdornment,
  Link as MuiLink,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Search, TriangleAlert, Users } from 'lucide-react';
import { type ReactNode, useEffect, useId, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useT } from '../../app/i18n.js';
import { ROUTES } from '../../app/route-paths.js';
import { useSemanticTokens } from '../../app/tokens.js';
import { currentBrand, useContactsApi, useSession } from '../../auth/session.tsx';
import { EmptyState } from '../../shell/empty-state.tsx';
import { PageHeader } from '../../shell/page-header.tsx';
import { useDebounced } from '../../ui/use-debounced.js';
import { AccountDialog } from './contact-dialogs.tsx';
import { AccountsTable, ContactsTable } from './contact-tables.tsx';
import { pageRange } from './format.js';
import { useContactAction } from './use-contact-action.js';

/**
 * `Admin/Contacts`: everybody this brand has heard from, and the companies they
 * belong to.
 *
 * **The URL is the state.** The search term, the filters, the tab and the page
 * live in the query string, so a filtered list is a link an agent can send to a
 * colleague, and the browser's back button steps back through what they looked
 * at rather than out of the screen.
 *
 * **Search is debounced, not throttled.** A request per keystroke against a
 * table of contacts is the query that gets expensive first, and a person typing
 * an address types it in one burst.
 */

const SEARCH_DEBOUNCE_MS = 250;

type Tab = 'people' | 'accounts';

export function ContactsPage(): ReactNode {
  const t = useT();
  const session = useSession();
  const api = useContactsApi();
  const tokens = useSemanticTokens();
  const navigate = useNavigate();
  const searchId = useId();
  const [params, setParams] = useSearchParams();

  const brand = currentBrand(session);
  const tab: Tab = params.get('tab') === 'accounts' ? 'accounts' : 'people';
  const search = params.get('q') ?? '';
  const accountId = params.get('account') ?? undefined;
  const openOnly = params.get('open') === 'true';
  const duplicatesOnly = params.get('duplicates') === 'true';
  const cursor = params.get('cursor') ?? undefined;
  const offset = Number(cursor ?? 0);

  const [typed, setTyped] = useState(search);
  const [accountDialogOpen, setAccountDialogOpen] = useState(false);
  const debounced = useDebounced(typed, SEARCH_DEBOUNCE_MS);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (debounced !== search) {
      setParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          if (debounced === '') {
            next.delete('q');
          } else {
            next.set('q', debounced);
          }
          // A new search is a new list, so the page it was on means nothing.
          next.delete('cursor');
          return next;
        },
        { replace: true },
      );
    }
  }, [debounced, search, setParams]);

  const query: ContactSearchQuery = {
    ...(search === '' ? {} : { search }),
    ...(accountId === undefined ? {} : { accountId }),
    ...(openOnly ? { hasOpenTickets: true } : {}),
    ...(duplicatesOnly ? { duplicates: true } : {}),
    ...(cursor === undefined ? {} : { cursor }),
  };

  const contacts = useQuery({
    queryKey: ['contacts', brand.id, query],
    queryFn: () => api.listContacts(brand.id, query),
    enabled: tab === 'people',
  });

  const accounts = useQuery({
    queryKey: ['accounts', brand.id, search],
    queryFn: () => api.listAccounts(brand.id, search === '' ? {} : { search }),
    enabled: tab === 'accounts',
  });

  const setParam = (key: string, value: string | null): void => {
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      if (value === null) {
        next.delete(key);
      } else {
        next.set(key, value);
      }
      if (key !== 'cursor') {
        next.delete('cursor');
      }
      return next;
    });
  };

  const createAccount = useContactAction(
    (value: { name: string; domain: string | null }) => api.createAccount(brand.id, value),
    (value) => t('contacts:toast.accountCreated', { name: value.name }),
    async () => {
      await queryClient.invalidateQueries({ queryKey: ['accounts', brand.id] });
    },
  );

  const rows = contacts.data?.contacts ?? [];
  const total = contacts.data?.total ?? 0;
  const duplicateCount = contacts.data?.duplicateCount ?? 0;
  const accountRows = accounts.data?.accounts ?? [];
  const range = pageRange(offset, rows.length, total);

  return (
    <>
      <PageHeader
        title={t('contacts:title')}
        caption={t('contacts:subtitle', {
          people: t('contacts:peopleCount', { count: total }),
          accounts: t('contacts:accountCount', { count: accounts.data?.total ?? 0 }),
        })}
        action={
          <Button
            variant="contained"
            onClick={() => {
              if (tab === 'accounts') {
                setAccountDialogOpen(true);
              } else {
                void navigate(ROUTES.contactNew);
              }
            }}
          >
            {t(tab === 'accounts' ? 'contacts:newAccount' : 'contacts:newContact')}
          </Button>
        }
      />

      <Box sx={{ display: 'flex', gap: 4, alignItems: 'center', marginBlockEnd: 5 }}>
        <ToggleButtonGroup
          exclusive
          size="small"
          value={tab}
          aria-label={t('contacts:segment.label')}
          onChange={(_event, next: Tab | null) => {
            if (next !== null) {
              setParam('tab', next === 'people' ? null : next);
            }
          }}
        >
          <ToggleButton value="people">{t('contacts:segment.people')}</ToggleButton>
          <ToggleButton value="accounts">{t('contacts:segment.accounts')}</ToggleButton>
        </ToggleButtonGroup>

        <TextField
          id={searchId}
          value={typed}
          onChange={(event) => {
            setTyped(event.target.value);
          }}
          placeholder={t(
            tab === 'accounts' ? 'contacts:accountSearchPlaceholder' : 'contacts:searchPlaceholder',
          )}
          size="small"
          sx={{ width: 280 }}
          slotProps={{
            htmlInput: { 'aria-label': t('contacts:searchPlaceholder') },
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <Search size={16} aria-hidden="true" />
                </InputAdornment>
              ),
            },
          }}
        />
      </Box>

      {tab === 'people' ? (
        <Box
          component="nav"
          aria-label={t('contacts:filters.label')}
          sx={{
            display: 'flex',
            gap: 2,
            alignItems: 'center',
            flexWrap: 'wrap',
            marginBlockEnd: 5,
          }}
        >
          <Chip
            size="small"
            label={t('contacts:filters.accountAny')}
            variant={accountId === undefined ? 'outlined' : 'filled'}
            {...(accountId === undefined
              ? {}
              : {
                  onDelete: () => {
                    setParam('account', null);
                  },
                })}
          />
          <Chip
            size="small"
            label={t('contacts:filters.openTickets')}
            variant={openOnly ? 'filled' : 'outlined'}
            onClick={() => {
              setParam('open', openOnly ? null : 'true');
            }}
            {...(openOnly
              ? {
                  onDelete: () => {
                    setParam('open', null);
                  },
                }
              : {})}
          />
          <Chip size="small" label={t('contacts:filters.tagAny')} variant="outlined" />

          {duplicateCount > 0 ? (
            <Typography
              variant="caption"
              sx={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 1,
                color: tokens['status.warning.text'],
                marginInlineStart: 'auto',
              }}
            >
              <TriangleAlert size={14} aria-hidden="true" />
              {t('contacts:filters.duplicates', { count: duplicateCount })}
              {' · '}
              <MuiLink
                component="button"
                type="button"
                onClick={() => {
                  setParam('duplicates', duplicatesOnly ? null : 'true');
                }}
              >
                {t('contacts:filters.review')}
              </MuiLink>
            </Typography>
          ) : null}
        </Box>
      ) : null}

      {tab === 'people' ? (
        <ContactsTable
          contacts={rows}
          brandName={brand.name}
          empty={
            rows.length === 0 && !contacts.isPending ? (
              <Box sx={{ padding: 8, textAlign: 'center' }}>
                <Typography variant="h3" component="p">
                  {search === ''
                    ? t('contacts:empty.heading')
                    : t('contacts:empty.noMatchesHeading')}
                </Typography>
                <Typography variant="body2" sx={{ color: 'text.secondary', marginBlockStart: 2 }}>
                  {search === ''
                    ? t('contacts:empty.body', { brand: brand.name })
                    : t('contacts:empty.noMatchesBody')}
                </Typography>
              </Box>
            ) : null
          }
          footer={
            <Box
              sx={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                paddingInline: 4,
                paddingBlock: 3,
                borderBlockStart: `1px solid ${tokens['border.default']}`,
              }}
            >
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                {t('contacts:pagination.range', range)}
              </Typography>
              <Box sx={{ display: 'flex', gap: 1 }}>
                <IconButton
                  size="small"
                  aria-label={t('contacts:pagination.previous')}
                  disabled={cursor === undefined}
                  onClick={() => {
                    setParams((previous) => {
                      const next = new URLSearchParams(previous);
                      next.delete('cursor');
                      return next;
                    });
                  }}
                >
                  <ChevronLeft size={16} aria-hidden="true" />
                </IconButton>
                <IconButton
                  size="small"
                  aria-label={t('contacts:pagination.next')}
                  disabled={contacts.data?.nextCursor == null}
                  onClick={() => {
                    setParam('cursor', contacts.data?.nextCursor ?? null);
                  }}
                >
                  <ChevronRight size={16} aria-hidden="true" />
                </IconButton>
              </Box>
            </Box>
          }
        />
      ) : accountRows.length === 0 && !accounts.isPending ? (
        <EmptyState
          icon={Users}
          heading={t('contacts:empty.accountsHeading')}
          body={t('contacts:empty.accountsBody')}
        />
      ) : (
        <AccountsTable accounts={accountRows} />
      )}

      <AccountDialog
        open={accountDialogOpen}
        account={null}
        busy={createAccount.isPending}
        onClose={() => {
          setAccountDialogOpen(false);
        }}
        onSubmit={(value) => {
          setAccountDialogOpen(false);
          createAccount.mutate(value);
        }}
      />
    </>
  );
}
