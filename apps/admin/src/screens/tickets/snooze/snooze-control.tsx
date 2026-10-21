import { dir } from '@helpdock/i18n';
import type { SnoozePresetKey } from '@helpdock/schemas';
import { Box, Button, Divider, ListSubheader, Menu, MenuItem, Typography } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { Clock } from 'lucide-react';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { useT } from '../../../app/i18n.js';
import { usePreferences } from '../../../app/providers.tsx';
import { useStaffApi, useTicketsApi } from '../../../auth/session.tsx';
import { useAriaKeyShortcuts } from '../../../keyboard/keyboard-provider.tsx';
import { ticketKeys } from '../../../tickets/keys.js';
import { isolate, wakeTime } from '../format.js';
import { SnoozePickerDialog } from './snooze-picker-dialog.tsx';

/**
 * The header's Snooze button and the menu it opens (M14-02, DESIGN §6.4
 * SnoozeMenu, `Admin/Ticket-Snooze`): four presets with the absolute time at
 * the inline end, and "Pick a date and time…".
 *
 * The presets are worked out by the api against the ticket's department
 * calendar and read when the menu opens, so the menu shows the instant the
 * server will accept. Next business day and Next week carry a caption with the
 * department's own time when its zone is not the reader's. If the read fails
 * the picker is still there: a person can always choose a time.
 *
 * `openSignal` is the `h` shortcut: a new value opens the menu on the button.
 */

const PRESET_KEYS: readonly SnoozePresetKey[] = [
  'in_1_hour',
  'in_4_hours',
  'next_business_day',
  'next_week',
];

/** Presets that depend on a calendar, and so can differ by zone. */
const CALENDAR_PRESETS: ReadonlySet<SnoozePresetKey> = new Set(['next_business_day', 'next_week']);

export function SnoozeControl({
  brandId,
  ticketId,
  busy,
  openSignal,
  onSnooze,
}: {
  readonly brandId: string;
  readonly ticketId: string;
  readonly busy: boolean;
  readonly openSignal: number;
  onSnooze(until: string): void;
}): ReactNode {
  const t = useT();
  const menuId = useId();
  const keys = useAriaKeyShortcuts('ticket.snooze');
  const button = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);

  // The `h` shortcut: each press is a new signal, and opens the menu.
  useEffect(() => {
    if (openSignal > 0 && button.current !== null) {
      setAnchor(button.current);
    }
  }, [openSignal]);

  return (
    <>
      <Button
        ref={button}
        variant="outlined"
        size="small"
        startIcon={<Clock size={16} aria-hidden="true" />}
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        aria-controls={anchor === null ? undefined : menuId}
        aria-keyshortcuts={keys}
        disabled={busy}
        onClick={(event) => {
          setAnchor(event.currentTarget);
        }}
      >
        {t('tickets:snooze.button')}
      </Button>

      <SnoozeMenu
        id={menuId}
        brandId={brandId}
        ticketId={ticketId}
        anchor={anchor}
        busy={busy}
        onClose={() => {
          setAnchor(null);
        }}
        onSnooze={onSnooze}
      />
    </>
  );
}

/**
 * The menu and the picker dialog, driven by whoever owns the anchor: the
 * header's button here, and the bulk bar's Snooze (M14-04), which reads the
 * presets against the first selected ticket's department calendar.
 */
export function SnoozeMenu({
  id,
  brandId,
  ticketId,
  anchor,
  busy,
  onClose,
  onSnooze,
}: {
  readonly id: string;
  readonly brandId: string;
  readonly ticketId: string;
  readonly anchor: HTMLElement | null;
  readonly busy: boolean;
  onClose(): void;
  onSnooze(until: string): void;
}): ReactNode {
  const t = useT();
  const api = useTicketsApi();
  const { locale } = usePreferences();
  const [picking, setPicking] = useState(false);
  const staffApi = useStaffApi();
  // The picker reads what is typed in the browser's zone, so it says that one;
  // the presets (Next business day at nine) are worked out in the zone the
  // person chose in their profile (M14-12), the browser's until they do.
  const profile = useQuery({
    queryKey: ['me', 'profile'],
    queryFn: () => staffApi.profile(),
    staleTime: 60_000,
  });
  const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const agentZone = profile.data?.timeZone ?? browserZone;
  const end = dir(locale) === 'rtl' ? 'left' : 'right';

  const presets = useQuery({
    queryKey: [...ticketKeys.brand(brandId), 'snooze-presets', ticketId, agentZone],
    queryFn: () => api.snoozePresets(brandId, ticketId, agentZone),
    enabled: anchor !== null && !profile.isPending,
    gcTime: 0,
  });

  const close = onClose;
  const now = Date.now();
  const data = presets.data;
  const departmentZone = data?.departmentTimeZone ?? null;
  const differs = departmentZone !== null && departmentZone !== agentZone;

  return (
    <>
      <Menu
        id={id}
        anchorEl={anchor}
        open={anchor !== null}
        onClose={close}
        anchorOrigin={{ vertical: 'bottom', horizontal: end }}
        transformOrigin={{ vertical: 'top', horizontal: end }}
        slotProps={{
          list: { 'aria-label': t('tickets:snooze.menuLabel'), dense: true },
          paper: { sx: { width: 360, padding: '4px 0', borderRadius: '10px' } },
        }}
      >
        <ListSubheader
          component="div"
          sx={{ fontSize: 12, fontWeight: 500, lineHeight: '20px', paddingBlock: 1 }}
        >
          {t('tickets:snooze.menuLabel')}
        </ListSubheader>
        {presets.isPending ? (
          <MenuItem disabled sx={{ minHeight: 36, fontSize: 14 }}>
            {t('tickets:snooze.loading')}
          </MenuItem>
        ) : null}
        {presets.isError ? (
          <MenuItem disabled sx={{ minHeight: 36, fontSize: 13, whiteSpace: 'normal' }}>
            {t('tickets:snooze.presetsFailed')}
          </MenuItem>
        ) : null}
        {PRESET_KEYS.flatMap((key) => {
          const preset = data?.presets.find((candidate) => candidate.key === key);
          if (preset === undefined) {
            return [];
          }

          return [
            <MenuItem
              key={key}
              onClick={() => {
                close();
                onSnooze(preset.at);
              }}
              sx={{ minHeight: 36, gap: 3, borderRadius: '6px', marginInline: 1, fontSize: 14 }}
            >
              <Box sx={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                <span>{t(`tickets:snooze.preset.${key}`)}</span>
                {differs && CALENDAR_PRESETS.has(key) ? (
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ whiteSpace: 'normal' }}
                  >
                    {t('tickets:snooze.departmentTime', {
                      department: data?.departmentName ?? '',
                      time: isolate(wakeTime(preset.at, locale, now, departmentZone)),
                      zone: isolate(departmentZone),
                    })}
                  </Typography>
                ) : null}
              </Box>
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ marginInlineStart: 'auto', whiteSpace: 'nowrap' }}
              >
                <bdi>{wakeTime(preset.at, locale, now)}</bdi>
              </Typography>
            </MenuItem>,
          ];
        })}
        <Divider sx={{ marginBlock: 1 }} />
        <MenuItem
          onClick={() => {
            close();
            setPicking(true);
          }}
          sx={{ minHeight: 36, borderRadius: '6px', marginInline: 1, fontSize: 14 }}
        >
          {t('tickets:snooze.pick')}
        </MenuItem>
      </Menu>

      <SnoozePickerDialog
        open={picking}
        agentZone={browserZone}
        departmentName={data?.departmentName ?? ''}
        departmentZone={differs ? departmentZone : null}
        busy={busy}
        onClose={() => {
          setPicking(false);
        }}
        onSubmit={(until) => {
          setPicking(false);
          onSnooze(until);
        }}
      />
    </>
  );
}
