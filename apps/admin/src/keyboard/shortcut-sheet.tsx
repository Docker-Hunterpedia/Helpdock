import { Box, Button, Dialog, Typography } from '@mui/material';
import { type ReactNode, useCallback, useId } from 'react';
import { useT } from '../app/i18n.js';
import { useSemanticTokens } from '../app/tokens.js';
import { Switch } from '../ui/switch.tsx';
import { visuallyHidden } from '../ui/visually-hidden.js';
import { KeyCombo } from './key-combo.tsx';
import {
  groupOf,
  isSingleKey,
  SHORTCUT_GROUPS,
  SHORTCUT_LIST,
  type ShortcutGroup,
  type ShortcutPermission,
  shortcutLabel,
} from './registry.js';

/**
 * DESIGN §6.4 ShortcutSheet (`Admin/ShortcutSheet`, M14-01): the `?` dialog.
 *
 * Every row is an entry of the shortcut registry the person may use, so the
 * sheet cannot list a key that does nothing; a Viewer sees navigation only.
 * Five groups in three columns (one below the `md` breakpoint). The footer holds the
 * single-key switch, saved to the account: off greys out every row without a
 * modifier and says so in words, because the grey alone would not.
 *
 * Focus starts on the title, so a screen reader reads the sheet from the top;
 * `Esc` and Close return it to where it was.
 */
export function ShortcutSheet({
  open,
  singleKeys,
  saving,
  permits,
  onSingleKeysChange,
  onClose,
}: {
  readonly open: boolean;
  readonly singleKeys: boolean;
  /**
   * The switch is being saved. Said with `aria-busy` rather than `disabled`:
   * a disabled button drops the focus it holds.
   */
  readonly saving: boolean;
  readonly permits: (permission: ShortcutPermission | undefined) => boolean;
  onSingleKeysChange(on: boolean): void;
  onClose(): void;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const titleId = useId();
  const hintId = useId();
  // Stable, so it runs as the title mounts and not again on every render,
  // which would pull focus back from the switch each time it is toggled.
  const focusTitle = useCallback((node: HTMLElement | null) => {
    node?.focus();
  }, []);

  const offered = SHORTCUT_LIST.filter((shortcut) => permits(shortcut.permission));
  const groups = SHORTCUT_GROUPS.map((group) => ({
    group,
    rows: offered.filter((shortcut) => groupOf(shortcut) === group),
  })).filter(({ rows }) => rows.length > 0);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      aria-labelledby={titleId}
      maxWidth={false}
      slotProps={{
        paper: {
          // The exit animation keeps the paper mounted after Close. It no
          // longer owns keys once closed, even before that animation ends.
          'aria-hidden': !open || undefined,
          sx: {
            width: 860,
            maxWidth: 'calc(100% - 32px)',
            margin: 4,
            padding: 6,
            borderRadius: '10px',
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
          },
        },
      }}
    >
      <Typography
        id={titleId}
        variant="h3"
        component="h2"
        tabIndex={-1}
        // Focused as it mounts, before the dialog's focus trap looks for
        // something to focus, so the trap finds focus already inside.
        ref={focusTitle}
        sx={{ outline: 'none' }}
      >
        {t('tickets:keyboard.label')}
      </Typography>

      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'repeat(3, minmax(0, 1fr))' },
          rowGap: 5,
          columnGap: 6,
        }}
      >
        {groups.map(({ group, rows }) => (
          <ShortcutGroupList key={group} group={group}>
            {rows.map((shortcut) => {
              const off = !singleKeys && isSingleKey(shortcut);
              return (
                <Box
                  key={shortcut.id}
                  sx={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: 3,
                    minHeight: 28,
                    opacity: off ? 0.5 : 1,
                  }}
                >
                  <Box component="dt" sx={{ fontSize: 13, lineHeight: '20px' }}>
                    {t(shortcutLabel(shortcut.id))}
                    {off ? (
                      <Box component="span" sx={visuallyHidden}>
                        {t('tickets:keyboard.offSuffix')}
                      </Box>
                    ) : null}
                  </Box>
                  <Box component="dd" sx={{ margin: 0 }}>
                    <KeyCombo keys={shortcut.keys} />
                  </Box>
                </Box>
              );
            })}
          </ShortcutGroupList>
        ))}
      </Box>

      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 3,
          paddingBlockStart: 3,
          borderBlockStart: `1px solid ${tokens['border.default']}`,
        }}
      >
        <Switch
          checked={singleKeys}
          label={t('tickets:keyboard.singleKey')}
          describedBy={hintId}
          busy={saving}
          onChange={onSingleKeysChange}
        />
        <Box sx={{ display: 'flex', flexDirection: 'column' }}>
          <Typography variant="body2" component="span" sx={{ fontSize: 13, fontWeight: 500 }}>
            {t('tickets:keyboard.singleKey')}
          </Typography>
          <Typography id={hintId} variant="caption" sx={{ color: 'text.secondary' }}>
            {t('tickets:keyboard.hint')}
          </Typography>
        </Box>
      </Box>

      <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Button variant="outlined" onClick={onClose}>
          {t('tickets:keyboard.close')}
        </Button>
      </Box>
    </Dialog>
  );
}

function ShortcutGroupList({
  group,
  children,
}: {
  readonly group: ShortcutGroup;
  readonly children: ReactNode;
}): ReactNode {
  const t = useT();
  const headingId = useId();

  return (
    <Box component="section" aria-labelledby={headingId}>
      <Typography
        id={headingId}
        variant="caption"
        component="h3"
        sx={{ display: 'block', fontWeight: 600, color: 'text.secondary', marginBlockEnd: 1 }}
      >
        {t(`tickets:keyboard.groups.${group}`)}
      </Typography>
      <Box component="dl" sx={{ margin: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
        {children}
      </Box>
    </Box>
  );
}
