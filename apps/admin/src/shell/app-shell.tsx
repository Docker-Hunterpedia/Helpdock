import { Box, Drawer, IconButton, Typography, useMediaQuery } from '@mui/material';
import { Menu as MenuIcon } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Outlet } from 'react-router';
import { useT } from '../app/i18n.js';
import { useSemanticTokens } from '../app/tokens.js';
import { currentBrand, useSession } from '../auth/session.tsx';
import { BrandMark } from '../ui/brand-mark.tsx';
import { SIDEBAR_WIDTH, Sidebar } from './sidebar.tsx';

/** DESIGN §6.5: below 1024 px the list and the sidebar become drawers. */
const SIDEBAR_BREAKPOINT = '(min-width:1024px)';

const TOP_BAR_HEIGHT = 56;

/**
 * The admin chrome: sidebar plus content area, both on `bg.canvas`. Everything
 * below it is a page rendered into the `Outlet`.
 */
export function AppShell(): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const session = useSession();
  const wide = useMediaQuery(SIDEBAR_BREAKPOINT, { noSsr: true });
  const brand = currentBrand(session);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const content = (
    <Box
      component="main"
      sx={{ flex: 1, minWidth: 0, padding: 8, backgroundColor: tokens['bg.canvas'] }}
    >
      <Outlet />
    </Box>
  );

  if (wide) {
    return (
      <Box sx={{ display: 'flex', minHeight: '100dvh', backgroundColor: tokens['bg.canvas'] }}>
        <Box sx={{ position: 'sticky', insetBlockStart: 0, height: '100dvh' }}>
          <Sidebar />
        </Box>
        {content}
      </Box>
    );
  }

  return (
    <Box sx={{ minHeight: '100dvh', backgroundColor: tokens['bg.canvas'] }}>
      <Box
        component="header"
        sx={{
          height: TOP_BAR_HEIGHT,
          display: 'flex',
          alignItems: 'center',
          gap: 3,
          paddingInline: 3,
          borderBlockEnd: `1px solid ${tokens['border.default']}`,
        }}
      >
        <IconButton
          aria-label={t('admin:nav.open')}
          aria-expanded={drawerOpen}
          onClick={() => {
            setDrawerOpen(true);
          }}
        >
          <MenuIcon size={16} aria-hidden="true" />
        </IconButton>
        <BrandMark initial={brand.name.slice(0, 1)} size={24} />
        <Typography variant="bodyStrong" component="span" noWrap>
          {brand.name}
        </Typography>
      </Box>

      <Drawer
        open={drawerOpen}
        onClose={() => {
          setDrawerOpen(false);
        }}
        slotProps={{ paper: { sx: { width: SIDEBAR_WIDTH } } }}
      >
        {/* Leaving the drawer open would hide the page it just navigated to. */}
        <Sidebar
          onNavigate={() => {
            setDrawerOpen(false);
          }}
        />
      </Drawer>

      {content}
    </Box>
  );
}
