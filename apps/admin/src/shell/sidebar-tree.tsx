import { Box, ListSubheader, Menu, MenuItem, Popover, Typography } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, type LucideIcon } from 'lucide-react';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { useT } from '../app/i18n.js';
import { usePreferences } from '../app/providers.tsx';
import { useSemanticTokens } from '../app/tokens.js';
import { assistKeys } from '../assist/api.js';
import { useAssistApi } from '../assist/context.tsx';
import { currentBrand, useSession } from '../auth/session.tsx';
import { managesHelpCenter } from '../screens/help-center/tabs.js';
import { TicketViewsNav } from '../screens/tickets/views-nav.tsx';
import { CountBadge } from './count-badge.tsx';
import { RailTooltip } from './rail-tooltip.tsx';
import {
  type SectionKey,
  sectionAt,
  sectionsFor,
  settingsGroupAt,
  type TreeGroup,
  type TreeLeaf,
  type TreeSection,
} from './sidebar-sections.js';

/**
 * The sidebar's tree (`Admin/UX-Fixes-2026-11`): one top-level section open at
 * a time and one Settings group at a time. The current page's branch opens by
 * itself and is scrolled into view; the person can open another by hand.
 *
 * - A section's row goes to its first page while the section is closed. On the
 *   current section it only folds, and so does its chevron.
 * - A Settings group's row only expands.
 * - Everything stays mounted while folded (`hidden`), so the view counts keep
 *   their live subscription and nothing remounts on a fold.
 */

type CatalogKey = `${string}:${string}`;

/** The sidebar's scroll area fades in over 200 ms; reveal the page once more after that. */
const REVEAL_AGAIN_MS = 260;
const label = (t: (key: never) => string, key: CatalogKey): string => t(key as never);

/** The chevron of a row: right (left in Arabic) when closed, down when open. */
function Chevron({ open }: { readonly open: boolean }): ReactNode {
  const { locale } = usePreferences();
  return open ? (
    <ChevronDown size={14} aria-hidden="true" style={{ flexShrink: 0 }} />
  ) : (
    <ChevronRight
      size={14}
      aria-hidden="true"
      style={{ flexShrink: 0, transform: locale === 'ar' ? 'scaleX(-1)' : undefined }}
    />
  );
}

export function SidebarTree({
  onNavigate,
}: {
  readonly onNavigate?: (() => void) | undefined;
}): ReactNode {
  const session = useSession();
  const { pathname } = useLocation();
  const rootRef = useRef<HTMLDivElement>(null);
  const treeId = useId();
  const sections = sectionsFor(session.user);
  const current = sectionAt(pathname);
  const [openSection, setOpenSection] = useState<SectionKey | null>(current);
  const [openGroup, setOpenGroup] = useState<string | null>(settingsGroupAt(pathname));

  // A new page opens its own branch, whatever was opened by hand.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only the path decides.
  useEffect(() => {
    setOpenSection(sectionAt(pathname));
    setOpenGroup(settingsGroupAt(pathname));
  }, [pathname]);

  // The current page stays in view inside the sidebar's own scroll area. The
  // list is still settling when a page loads (the views arrive, the scroll
  // area fades in), so it is brought into view again a moment later.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when the branch or the page changes.
  useEffect(() => {
    const reveal = (): void => {
      const marked = rootRef.current?.querySelectorAll(
        '[aria-current]:not([aria-current="false"])',
      );
      const active = marked === undefined ? undefined : Array.from(marked).at(-1);
      if (active instanceof HTMLElement && typeof active.scrollIntoView === 'function') {
        active.scrollIntoView({ block: 'nearest' });
      }
    };
    reveal();
    const later = setTimeout(reveal, REVEAL_AGAIN_MS);
    return () => {
      clearTimeout(later);
    };
  }, [pathname, openSection, openGroup]);

  return (
    <Box ref={rootRef} component="ul" sx={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {sections.map((section) => (
        <Box component="li" key={section.key}>
          <SectionRow
            section={section}
            bodyId={`${treeId}-${section.key}`}
            isCurrent={current === section.key}
            open={openSection === section.key}
            count={session.navCounts?.[section.nav]}
            onToggle={() => {
              setOpenSection(openSection === section.key ? null : section.key);
            }}
            onOpen={() => {
              setOpenSection(section.key);
            }}
            onNavigate={onNavigate}
          />
          {section.kind === 'link' ? null : (
            <SectionBody
              section={section}
              id={`${treeId}-${section.key}`}
              open={openSection === section.key}
              openGroup={openGroup}
              onOpenGroup={setOpenGroup}
              pathname={pathname}
              onNavigate={onNavigate}
            />
          )}
        </Box>
      ))}
    </Box>
  );
}

function SectionRow({
  section,
  bodyId,
  isCurrent,
  open,
  count,
  onToggle,
  onOpen,
  onNavigate,
}: {
  readonly section: TreeSection;
  readonly bodyId: string;
  readonly isCurrent: boolean;
  readonly open: boolean;
  readonly count: number | undefined;
  onToggle(): void;
  onOpen(): void;
  readonly onNavigate?: (() => void) | undefined;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const Icon = section.icon;
  const name = label(t, section.labelKey);
  const expandable = section.kind !== 'link';

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        height: 36,
        borderRadius: '6px',
        backgroundColor: isCurrent ? tokens['bg.muted'] : 'transparent',
        '&:hover': { backgroundColor: tokens['bg.muted'] },
      }}
    >
      <Link
        to={section.path}
        aria-current={isCurrent && !expandable ? 'page' : undefined}
        onClick={(event) => {
          if (!expandable) {
            onNavigate?.();
            return;
          }
          if (isCurrent) {
            // The row of the current section only folds it.
            event.preventDefault();
            onToggle();
            return;
          }
          onOpen();
        }}
        style={{
          textDecoration: 'none',
          color: 'inherit',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          flex: 1,
          minWidth: 0,
          height: '100%',
          paddingInline: 12,
          borderRadius: 6,
        }}
      >
        <Icon size={16} aria-hidden="true" style={{ flexShrink: 0 }} />
        <Typography
          component="span"
          variant="body2"
          noWrap
          sx={{ flex: 1, fontWeight: isCurrent ? 500 : 400 }}
        >
          {name}
        </Typography>
        {count === undefined ? null : (
          <Typography component="span" variant="mono" sx={{ color: 'text.secondary' }}>
            {count}
          </Typography>
        )}
      </Link>
      {expandable ? (
        <Box
          component="button"
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          aria-label={t('admin:nav.pagesOf', { label: name })}
          onClick={onToggle}
          sx={{
            display: 'grid',
            placeItems: 'center',
            flexShrink: 0,
            width: 28,
            height: 28,
            marginInlineEnd: 1,
            border: 0,
            borderRadius: '6px',
            background: 'transparent',
            color: tokens['text.secondary'],
            cursor: 'pointer',
            '&:focus-visible': {
              outline: `2px solid ${tokens['border.focus']}`,
              outlineOffset: -2,
            },
          }}
        >
          <Chevron open={open} />
        </Box>
      ) : null}
    </Box>
  );
}

/** The branch under a section: the views, a list of pages, or Settings' groups. */
function SectionBody({
  section,
  id,
  open,
  openGroup,
  onOpenGroup,
  pathname,
  onNavigate,
}: {
  readonly section: TreeSection;
  readonly id: string;
  readonly open: boolean;
  readonly openGroup: string | null;
  onOpenGroup(group: string): void;
  readonly pathname: string;
  readonly onNavigate?: (() => void) | undefined;
}): ReactNode {
  const t = useT();
  const session = useSession();
  const brand = currentBrand(session);
  const assist = useAssistApi();
  // The Proposals page says how many drafts wait, as its tab used to.
  const proposals = useQuery({
    queryKey: assistKeys.proposalList(brand.id, 'waiting'),
    queryFn: () => assist.proposals(brand.id, { status: 'waiting' }),
    enabled: section.key === 'helpCenter' && managesHelpCenter(session.user.role),
  });

  return (
    <Box id={id} hidden={!open} sx={{ paddingBlockEnd: 1 }}>
      {section.kind === 'views' ? <TicketViewsNav onNavigate={onNavigate} /> : null}
      {section.kind === 'leaves' ? (
        <Box
          component="ul"
          aria-label={label(t, section.labelKey)}
          sx={{ listStyle: 'none', margin: 0, padding: 0, paddingInlineStart: 2 }}
        >
          {section.leaves.map((leaf) => (
            <Box component="li" key={leaf.id}>
              <LeafLink
                leaf={leaf}
                current={leaf.isCurrent(pathname)}
                onNavigate={onNavigate}
                count={leaf.id === 'proposals' ? proposals.data?.waiting : undefined}
              />
            </Box>
          ))}
        </Box>
      ) : null}
      {section.kind === 'groups' ? (
        <Box
          component="ul"
          aria-label={t('admin:settings.navLabel')}
          sx={{ listStyle: 'none', margin: 0, padding: 0, paddingInlineStart: 2 }}
        >
          {section.groups.map((group) => (
            <Box component="li" key={group.id}>
              <GroupRow
                group={group}
                open={openGroup === group.id}
                onOpen={() => {
                  onOpenGroup(group.id);
                }}
                pathname={pathname}
                onNavigate={onNavigate}
              />
            </Box>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}

function GroupRow({
  group,
  open,
  onOpen,
  pathname,
  onNavigate,
}: {
  readonly group: TreeGroup;
  readonly open: boolean;
  onOpen(): void;
  readonly pathname: string;
  readonly onNavigate?: (() => void) | undefined;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const buttonId = useId();
  const Icon = group.icon;

  return (
    <>
      <Box
        component="button"
        type="button"
        id={buttonId}
        aria-expanded={open}
        onClick={onOpen}
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 3,
          inlineSize: '100%',
          minHeight: 32,
          paddingInline: 3,
          border: 0,
          borderRadius: '6px',
          background: 'transparent',
          color: 'inherit',
          font: 'inherit',
          fontSize: 13,
          textAlign: 'start',
          cursor: 'pointer',
          '&:hover': { backgroundColor: tokens['bg.muted'] },
          '&:focus-visible': { outline: `2px solid ${tokens['border.focus']}`, outlineOffset: -2 },
        }}
      >
        <Icon size={16} aria-hidden="true" style={{ flexShrink: 0 }} />
        <Box component="span" sx={{ flex: 1, minWidth: 0 }}>
          {label(t, group.labelKey)}
        </Box>
        <Chevron open={open} />
      </Box>
      <Box
        hidden={!open}
        component="ul"
        aria-labelledby={buttonId}
        sx={{
          listStyle: 'none',
          margin: 0,
          marginInlineStart: '19px',
          paddingBlock: 0,
          paddingInlineStart: 2,
          borderInlineStart: `1px solid ${tokens['border.default']}`,
        }}
      >
        {group.leaves.map((leaf) => (
          <Box component="li" key={leaf.id}>
            <LeafLink leaf={leaf} current={leaf.isCurrent(pathname)} onNavigate={onNavigate} />
          </Box>
        ))}
      </Box>
    </>
  );
}

function LeafLink({
  leaf,
  current,
  count,
  onNavigate,
}: {
  readonly leaf: TreeLeaf;
  readonly current: boolean;
  readonly count?: number | undefined;
  readonly onNavigate?: (() => void) | undefined;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const Icon: LucideIcon = leaf.icon;
  const danger = leaf.danger === true;

  return (
    <Link
      to={leaf.path}
      aria-current={current ? 'page' : undefined}
      onClick={onNavigate}
      style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}
    >
      <Box
        sx={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 3,
          minHeight: 32,
          paddingBlock: '7px',
          paddingInline: 3,
          borderRadius: '6px',
          fontSize: 13,
          lineHeight: '18px',
          fontWeight: current ? 500 : 400,
          color: danger ? tokens['status.danger.text'] : 'inherit',
          backgroundColor: current ? tokens['bg.muted'] : 'transparent',
          '&:hover': { backgroundColor: tokens['bg.muted'] },
        }}
      >
        <Icon size={16} aria-hidden="true" style={{ flexShrink: 0, marginBlockStart: 1 }} />
        <Box component="span" sx={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
          {label(t, leaf.labelKey)}
        </Box>
        {count === undefined || count === 0 ? null : (
          <Typography component="span" variant="mono" sx={{ color: 'text.secondary' }}>
            {count}
          </Typography>
        )}
      </Box>
    </Link>
  );
}

/**
 * The collapsed rail's entry for a section: a plain link with a Tooltip where
 * the section has one page (Reports), a button opening a flyout with the same
 * entries where it has more.
 */
export function RailSection({
  section,
  count,
  current,
}: {
  readonly section: TreeSection;
  readonly count: number | undefined;
  readonly current: boolean;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const { locale } = usePreferences();
  const { pathname } = useLocation();
  const popoverId = useId();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const Icon = section.icon;
  const name = label(t, section.labelKey);
  const accessibleName =
    count === undefined ? name : t('admin:nav.withCount', { label: name, count });
  const end = locale === 'ar' ? 'left' : 'right';
  const start = locale === 'ar' ? 'right' : 'left';
  const close = (): void => {
    setAnchor(null);
  };

  const icon = (
    <Box
      sx={{
        position: 'relative',
        width: 36,
        height: 36,
        display: 'grid',
        placeItems: 'center',
        borderRadius: '6px',
        backgroundColor: current || anchor !== null ? tokens['bg.muted'] : 'transparent',
        '&:hover': { backgroundColor: tokens['bg.muted'] },
      }}
    >
      <Icon size={16} aria-hidden="true" />
      {count === undefined ? null : <CountBadge count={count} />}
    </Box>
  );

  if (section.kind === 'link') {
    return (
      <RailTooltip title={name}>
        <Link
          to={section.path}
          aria-label={accessibleName}
          aria-current={current ? 'page' : undefined}
          style={{ textDecoration: 'none', color: 'inherit', display: 'block', borderRadius: 6 }}
        >
          {icon}
        </Link>
      </RailTooltip>
    );
  }

  const button = (
    <Box
      component="button"
      type="button"
      aria-label={accessibleName}
      aria-haspopup={section.kind === 'views' ? 'dialog' : 'menu'}
      aria-expanded={anchor !== null}
      aria-controls={anchor === null ? undefined : popoverId}
      onClick={(event) => {
        setAnchor(event.currentTarget);
      }}
      sx={{
        padding: 0,
        border: 0,
        background: 'none',
        color: 'inherit',
        cursor: 'pointer',
        borderRadius: '6px',
        '&:focus-visible': { outline: `2px solid ${tokens['border.focus']}`, outlineOffset: -2 },
      }}
    >
      {icon}
    </Box>
  );
  const origin = {
    anchorOrigin: { vertical: 'top', horizontal: end } as const,
    transformOrigin: { vertical: 'top', horizontal: start } as const,
  };

  return (
    <>
      <RailTooltip title={name}>{button}</RailTooltip>
      {section.kind === 'views' ? (
        <Popover
          id={popoverId}
          open={anchor !== null}
          anchorEl={anchor}
          onClose={close}
          {...origin}
          slotProps={{
            paper: {
              role: 'dialog',
              'aria-label': t('tickets:views.label'),
              sx: { width: 220, padding: 2, marginInlineStart: 1 },
            },
          }}
        >
          <TicketViewsNav onNavigate={close} />
        </Popover>
      ) : (
        <Menu
          id={popoverId}
          open={anchor !== null}
          anchorEl={anchor}
          onClose={close}
          {...origin}
          slotProps={{
            paper: { sx: { width: 240, marginInlineStart: 1 } },
            list: { 'aria-label': name },
          }}
        >
          {flyoutItems(section, pathname, t, tokens, close)}
        </Menu>
      )}
    </>
  );
}

/** The flyout's rows: a heading per Settings group, then its pages, each with its icon. */
function flyoutItems(
  section: TreeSection,
  pathname: string,
  t: ReturnType<typeof useT>,
  tokens: ReturnType<typeof useSemanticTokens>,
  close: () => void,
): ReactNode[] {
  const item = (leaf: TreeLeaf): ReactNode => {
    const Icon = leaf.icon;
    const current = leaf.isCurrent(pathname);
    return (
      <MenuItem
        key={leaf.id}
        component={Link}
        to={leaf.path}
        selected={current}
        aria-current={current ? 'page' : undefined}
        onClick={close}
        sx={{
          gap: 3,
          alignItems: 'flex-start',
          whiteSpace: 'normal',
          fontSize: 13,
          color: leaf.danger === true ? tokens['status.danger.text'] : undefined,
        }}
      >
        <Icon size={16} aria-hidden="true" style={{ flexShrink: 0, marginBlockStart: 2 }} />
        {label(t, leaf.labelKey)}
      </MenuItem>
    );
  };

  // A Menu takes a flat list of children, so a group's heading and pages are siblings.
  return section.kind === 'groups'
    ? section.groups.flatMap((group) => [
        <ListSubheader key={`${group.id}-heading`} sx={{ lineHeight: '28px', fontSize: 12 }}>
          {label(t, group.labelKey)}
        </ListSubheader>,
        ...group.leaves.map(item),
      ])
    : section.leaves.map(item);
}
