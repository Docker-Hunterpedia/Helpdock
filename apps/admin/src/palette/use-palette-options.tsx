import { type Locale, NAMESPACES } from '@helpdock/i18n';
import type { QuickSearch } from '@helpdock/schemas';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  BookOpen,
  Compass,
  FileText,
  type LucideIcon,
  Search,
  Ticket,
  User,
  Zap,
} from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useT } from '../app/i18n.js';
import { usePreferences } from '../app/providers.tsx';
import { articleRoute, contactRoute, ROUTES, ticketRoute } from '../app/route-paths.js';
import { currentBrand, useContactsApi, useSession, useTicketsApi } from '../auth/session.tsx';
import type { KeyStroke } from '../keyboard/keys.js';
import { useQuickSearchApi } from './context.js';
import { fold } from './fold.js';
import {
  isolate,
  namesTicket,
  type PaletteGroup,
  RECENTS_SHOWN,
  rankLocal,
  ticketReference,
} from './model.js';
import { type PageEntry, pagesFor } from './pages.js';
import { forget, type Recent, readRecents } from './recents.js';
import type { PaletteAction } from './use-palette-actions.js';

/** What choosing an option does: go somewhere now, or do something once the palette has closed. */
export type PaletteEffect =
  | { readonly kind: 'go'; readonly to: string; readonly remember?: Recent }
  | { readonly kind: 'later'; readonly run: () => void };

export interface PaletteOption {
  readonly key: string;
  readonly group: PaletteGroup;
  readonly icon: LucideIcon;
  /** Reads left to right whatever the page direction: a reference or an address. */
  readonly primary: string;
  readonly secondary?: string;
  readonly keys?: readonly KeyStroke[];
  /** Draws the Enter cap: the row Enter opens, when it is an exact ticket. */
  readonly enter?: boolean;
  readonly effect: PaletteEffect;
}

type SectionName = 'tickets' | 'contacts' | 'articles';

export interface PaletteState {
  readonly options: readonly PaletteOption[];
  /** The query has a settled answer and nothing matched: the "no results" panel. */
  readonly empty: boolean;
  /** An answer is on its way (or the query is still being debounced). */
  readonly busy: boolean;
  readonly failedSections: readonly SectionName[];
  /** The whole request failed, not one section. */
  readonly searchFailed: boolean;
  retry(): void;
}

const SECTION_LIMIT = 5;

/** The words a page can be found by, in both languages. */
function usePageTexts(): (page: PageEntry) => readonly string[] {
  const { i18n } = useTranslation(NAMESPACES);
  return useMemo(() => {
    const texts = (lng: Locale) => {
      const fixed = i18n.getFixedT(lng);
      // `PageKey` is plain text; pages.test resolves every key in both languages.
      const say = (key: string): string => String(fixed(key as never));
      return (page: PageEntry): string[] => [
        page.title.map(say).join(' › '),
        ...say(`admin:palette.keywords.${page.id}`).split(/[,،]/),
      ];
    };
    const en = texts('en');
    const ar = texts('ar');
    return (page) =>
      [...en(page), ...ar(page)].map((text) => text.trim()).filter((text) => text !== '');
  }, [i18n]);
}

const ICON = {
  ticket: Ticket,
  contact: User,
  article: FileText,
  page: Compass,
  action: Zap,
  search: Search,
  book: BookOpen,
} as const;

export function usePaletteOptions(
  typed: string,
  debounced: string,
  actions: readonly PaletteAction[],
): PaletteState {
  const t = useT();
  const { i18n } = useTranslation(NAMESPACES);
  const session = useSession();
  const { locale } = usePreferences();
  const quickSearch = useQuickSearchApi();
  const ticketsApi = useTicketsApi();
  const contactsApi = useContactsApi();
  const pageTexts = usePageTexts();
  const brandId = currentBrand(session).id;
  const userId = session.user.id;
  const viewer = session.user;
  const query = typed.trim();

  const pages = useMemo(() => pagesFor(viewer), [viewer]);
  const pageTitle = useMemo(
    () =>
      (page: PageEntry): string =>
        page.title.map((key) => String(i18n.t(key as never))).join(' › '),
    [i18n],
  );

  const search = useQuery({
    queryKey: ['palette', 'quick-search', brandId, locale, debounced],
    queryFn: ({ signal }) =>
      quickSearch.search(brandId, { q: debounced, limit: SECTION_LIMIT, locale }, signal),
    enabled: debounced !== '',
    placeholderData: keepPreviousData,
    staleTime: 15_000,
    retry: false,
  });

  const recents = useQuery({
    queryKey: ['palette', 'recents', userId, brandId],
    queryFn: async (): Promise<PaletteOption[]> => {
      const stored = readRecents(userId, brandId).slice(0, RECENTS_SHOWN + 3);
      const resolved = await Promise.allSettled(
        stored.map(async (recent): Promise<PaletteOption> => {
          switch (recent.kind) {
            case 'ticket': {
              const { ticket } = await ticketsApi.ticket(brandId, recent.id);
              return {
                key: `recent:ticket:${recent.id}`,
                group: 'recent',
                icon: ICON.ticket,
                primary: ticketReference(ticket),
                secondary: ticket.subject,
                effect: { kind: 'go', to: ticketRoute(recent.id), remember: recent },
              };
            }
            case 'contact': {
              const contact = await contactsApi.contact(brandId, recent.id);
              return {
                key: `recent:contact:${recent.id}`,
                group: 'recent',
                icon: ICON.contact,
                primary: contact.name,
                effect: { kind: 'go', to: contactRoute(recent.id), remember: recent },
              };
            }
            case 'page': {
              const page = pages.find((candidate) => candidate.id === recent.id);
              if (page === undefined) {
                throw new Error('The page is gone or not offered');
              }
              return {
                key: `recent:page:${recent.id}`,
                group: 'recent',
                icon: ICON.page,
                primary: pageTitle(page),
                effect: { kind: 'go', to: page.path, remember: recent },
              };
            }
          }
        }),
      );
      // What the api no longer shows this person leaves the list for good.
      forget(
        userId,
        brandId,
        stored.filter((_recent, index) => resolved[index]?.status === 'rejected'),
      );
      return resolved
        .flatMap((outcome) => (outcome.status === 'fulfilled' ? [outcome.value] : []))
        .slice(0, RECENTS_SHOWN);
    },
    enabled: query === '',
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });

  const options = useMemo<PaletteOption[]>(() => {
    const actionOption = (action: PaletteAction): PaletteOption => ({
      key: `action:${action.id}`,
      group: 'actions',
      icon: ICON.action,
      primary: action.label,
      ...(action.keys === undefined ? {} : { keys: action.keys }),
      effect: { kind: 'later', run: action.run },
    });

    if (query === '') {
      return [
        ...(recents.data ?? []),
        ...actions.filter((action) => action.suggested).map(actionOption),
      ];
    }

    const found: QuickSearch | undefined = search.data;
    const answered = !search.isPlaceholderData && debounced === query;
    const ticketOptions =
      found?.tickets.status === 'ok'
        ? found.tickets.items.map((ticket, index): PaletteOption => {
            const reference = ticketReference(ticket);
            const exact = index === 0 && answered && namesTicket(query, ticket);
            return {
              key: `ticket:${ticket.id}`,
              group: 'tickets',
              icon: ICON.ticket,
              primary: exact
                ? t('admin:palette.openTicket', { reference: isolate(reference) })
                : reference,
              secondary: ticket.subject,
              ...(exact ? { enter: true } : {}),
              effect: {
                kind: 'go',
                to: ticketRoute(ticket.id),
                remember: { kind: 'ticket', id: ticket.id },
              },
            };
          })
        : [];
    const contactOptions =
      found?.contacts.status === 'ok'
        ? found.contacts.items.map(
            (contact): PaletteOption => ({
              key: `contact:${contact.id}`,
              group: 'contacts',
              icon: ICON.contact,
              primary: contact.name,
              ...(contact.identity === null ? {} : { secondary: contact.identity }),
              effect: {
                kind: 'go',
                to: contactRoute(contact.id),
                remember: { kind: 'contact', id: contact.id },
              },
            }),
          )
        : [];
    const articleOptions =
      found?.articles.status === 'ok'
        ? found.articles.items.map(
            (article): PaletteOption => ({
              key: `article:${article.id}`,
              group: 'articles',
              icon: ICON.article,
              primary: article.title,
              ...(article.status === 'published'
                ? {}
                : {
                    secondary: t(
                      article.status === 'draft'
                        ? 'admin:palette.draft'
                        : 'admin:palette.scheduled',
                    ),
                  }),
              effect: { kind: 'go', to: articleRoute(article.id) },
            }),
          )
        : [];
    const pageOptions = rankLocal(query, pages, pageTexts).map(
      (page): PaletteOption => ({
        key: `page:${page.id}`,
        group: 'pages',
        icon: ICON.page,
        primary: pageTitle(page),
        effect: {
          kind: 'go',
          to: page.path,
          ...(page.group === 'settings'
            ? { remember: { kind: 'page' as const, id: page.id } }
            : {}),
        },
      }),
    );
    const actionOptions = rankLocal(query, actions, (action) => action.texts).map(actionOption);

    return [
      ...ticketOptions,
      ...contactOptions,
      ...articleOptions,
      ...pageOptions,
      ...actionOptions,
      {
        key: 'search:tickets',
        group: 'search',
        icon: ICON.search,
        primary: t('admin:palette.seeAll', { query: isolate(query) }),
        effect: { kind: 'go', to: `${ROUTES.tickets}?q=${encodeURIComponent(query)}` },
      },
    ];
  }, [
    query,
    debounced,
    search.data,
    search.isPlaceholderData,
    recents.data,
    actions,
    pages,
    pageTexts,
    pageTitle,
    t,
  ]);

  const sections = search.data;
  const failedSections = (['tickets', 'contacts', 'articles'] as const).filter(
    (name) => sections?.[name].status === 'failed',
  );
  const settled = query !== '' && debounced === query && !search.isFetching;
  const matches = options.filter((option) => option.group !== 'search');

  return {
    options,
    empty: settled && !search.isError && failedSections.length === 0 && matches.length === 0,
    busy: query !== '' && (debounced !== query || search.isFetching),
    failedSections,
    searchFailed: query !== '' && search.isError && debounced === query,
    retry: () => {
      void search.refetch();
    },
  };
}

/** Folded text for tests and callers that match by hand. */
export const foldedTexts = (texts: readonly string[]): string[] => texts.map(fold);
