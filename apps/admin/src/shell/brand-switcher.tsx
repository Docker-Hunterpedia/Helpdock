import { Box, Menu, MenuItem, Typography } from '@mui/material';
import { Check, ChevronsUpDown } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { useT } from '../app/i18n.js';
import { currentBrand, useSession, useSwitchBrand } from '../auth/session.tsx';
import { BrandMark } from '../ui/brand-mark.tsx';
import { SidebarMenuTrigger } from './sidebar-menu-trigger.tsx';

/**
 * The sidebar header from the artboards `Admin/Settings` and `Admin/Staff`: the
 * brand's mark and name with a "Brand · switch" caption, opening a menu of the
 * brands this session can work in. The current one is a checked radio item, so
 * the state is announced and not only drawn.
 */
export function BrandSwitcher(): ReactNode {
  const t = useT();
  const session = useSession();
  const switchBrand = useSwitchBrand();
  const menuId = useId();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);

  const brand = currentBrand(session);
  const label = t('admin:brandSwitcher.action');

  return (
    <>
      <SidebarMenuTrigger label={label} menuId={menuId} open={anchor !== null} onOpen={setAnchor}>
        <BrandMark initial={brand.name.slice(0, 1)} />
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Typography variant="bodyStrong" noWrap component="span" sx={{ display: 'block' }}>
            {brand.name}
          </Typography>
          <Typography
            variant="caption"
            noWrap
            component="span"
            sx={{ display: 'block', color: 'text.secondary' }}
          >
            {t('admin:brandSwitcher.caption')}
          </Typography>
        </Box>
        <ChevronsUpDown size={16} aria-hidden="true" />
      </SidebarMenuTrigger>

      <Menu
        id={menuId}
        anchorEl={anchor}
        open={anchor !== null}
        onClose={() => {
          setAnchor(null);
        }}
        slotProps={{ list: { 'aria-label': label } }}
      >
        {session.brands.map((candidate) => {
          const isCurrent = candidate.id === brand.id;

          return (
            <MenuItem
              key={candidate.id}
              role="menuitemradio"
              aria-checked={isCurrent}
              onClick={() => {
                switchBrand(candidate.id);
                setAnchor(null);
              }}
              sx={{ gap: 3 }}
            >
              <Box sx={{ width: 16, display: 'grid', placeItems: 'center' }}>
                {isCurrent ? <Check size={16} aria-hidden="true" /> : null}
              </Box>
              {candidate.name}
            </MenuItem>
          );
        })}
      </Menu>
    </>
  );
}
