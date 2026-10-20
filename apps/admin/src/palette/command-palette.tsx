import { Box, Dialog, Typography } from '@mui/material';
import { Search } from 'lucide-react';
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { useNavigate } from 'react-router';
import { useT } from '../app/i18n.js';
import { useSemanticTokens } from '../app/tokens.js';
import { currentBrand, useSession } from '../auth/session.tsx';
import { KeyCombo } from '../keyboard/key-combo.tsx';
import { Kbd } from '../ui/kbd.tsx';
import { useDebounced } from '../ui/use-debounced.js';
import { visuallyHidden } from '../ui/visually-hidden.js';
import { groupOptions, inListOrder, moveActive } from './model.js';
import { remember } from './recents.js';
import { usePaletteActions } from './use-palette-actions.js';
import {
  type PaletteEffect,
  type PaletteOption,
  usePaletteOptions,
} from './use-palette-options.js';

/**
 * DESIGN §6.4 CommandPalette (`Admin/CommandPalette`, M14-05): `⌘K`.
 *
 * A dialog holding an ARIA 1.2 combobox and a grouped listbox. Focus stays in
 * the input and the active option is named by `aria-activedescendant`; the
 * arrows move it, Enter runs it, Esc closes and focus goes back to where it
 * was (MUI's focus trap restores it). Nothing in it takes the left and right
 * arrows, so the caret behaves in Arabic as in English.
 *
 * Choosing a place goes there at once; choosing an action waits until the
 * palette has finished closing, so the screen's handler (open the assignee
 * menu, focus the composer) is not fighting the dialog for focus.
 */

const SEARCH_DEBOUNCE_MS = 150;
const PALETTE_WIDTH = 640;

export function CommandPalette({
  open,
  onClose,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const navigate = useNavigate();
  const afterClose = useRef<(() => void) | null>(null);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth={false}
      scroll="paper"
      sx={{ '& .MuiDialog-container': { alignItems: 'flex-start' } }}
      slotProps={{
        transition: {
          onExited: () => {
            const pending = afterClose.current;
            afterClose.current = null;
            pending?.();
          },
        },
        paper: {
          'aria-label': t('admin:palette.label'),
          sx: {
            width: PALETTE_WIDTH,
            maxWidth: 'calc(100% - 32px)',
            marginBlockStart: '12vh',
            marginInline: 4,
            borderRadius: '10px',
            overflow: 'hidden',
            fontSize: 14,
            backgroundColor: tokens['bg.surface'],
          },
        },
      }}
    >
      <PaletteBody
        onGo={(to) => {
          void navigate(to);
          onClose();
        }}
        onLater={(run) => {
          afterClose.current = run;
          onClose();
        }}
        onClose={onClose}
      />
    </Dialog>
  );
}

function PaletteBody({
  onGo,
  onLater,
  onClose,
}: {
  readonly onGo: (to: string) => void;
  readonly onLater: (run: () => void) => void;
  readonly onClose: () => void;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const session = useSession();
  const listboxId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [typed, setTyped] = useState('');
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const debounced = useDebounced(typed.trim(), SEARCH_DEBOUNCE_MS);
  const actions = usePaletteActions(true);
  const state = usePaletteOptions(typed, debounced, actions);

  const ordered = inListOrder(state.options);
  const groups = groupOptions(state.options);
  const active = ordered.find((option) => option.key === activeKey) ?? ordered[0];
  const activeIndex = active === undefined ? -1 : ordered.indexOf(active);
  const optionId = (option: PaletteOption): string => `${listboxId}-${option.key}`;
  const showList = !state.empty && ordered.length > 0;
  const query = typed.trim();

  // Focus is taken by the dialog's own trap unless the input already holds it
  // when the trap looks; `autoFocus` runs too early for MUI's transition.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const choose = useCallback(
    (option: PaletteOption) => {
      const effect: PaletteEffect = option.effect;
      if (effect.kind === 'go') {
        if (effect.remember !== undefined) {
          remember(session.user.id, currentBrand(session).id, effect.remember);
        }
        onGo(effect.to);
      } else {
        onLater(effect.run);
      }
    },
    [onGo, onLater, session],
  );

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) {
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = ordered[moveActive(activeIndex, event.key, ordered.length)];
      setActiveKey(next?.key ?? null);
      // Only the keys scroll: a hover moving the list under the pointer would chase it.
      if (next !== undefined) {
        requestAnimationFrame(() => {
          document.getElementById(optionId(next))?.scrollIntoView?.({ block: 'nearest' });
        });
      }
      return;
    }
    if (event.key === 'Enter' && active !== undefined) {
      event.preventDefault();
      choose(active);
    }
  };

  const countText = state.empty
    ? t('admin:palette.noResults.title', { query })
    : query !== '' && !state.busy
      ? t('admin:palette.count', {
          count: ordered.filter((option) => option.group !== 'search').length,
        })
      : '';

  return (
    <>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 3,
          height: 52,
          paddingInline: 4,
          borderBlockEnd: `1px solid ${tokens['border.default']}`,
          '&:focus-within': { boxShadow: `inset 0 -2px 0 ${tokens['border.focus']}` },
        }}
      >
        <Box
          component="span"
          aria-hidden="true"
          sx={{ display: 'inline-flex', color: tokens['text.secondary'] }}
        >
          <Search size={16} />
        </Box>
        <Box
          component="input"
          ref={inputRef}
          role="combobox"
          aria-expanded={showList}
          aria-controls={showList ? listboxId : undefined}
          aria-activedescendant={showList && active !== undefined ? optionId(active) : undefined}
          aria-autocomplete="list"
          aria-label={t('admin:palette.placeholder')}
          placeholder={t('admin:palette.placeholder')}
          autoComplete="off"
          spellCheck={false}
          value={typed}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
            setTyped(event.target.value);
            setActiveKey(null);
          }}
          onKeyDown={onKeyDown}
          sx={{
            flexGrow: 1,
            minWidth: 0,
            border: 0,
            outline: 0,
            padding: 0,
            font: 'inherit',
            fontSize: 16,
            color: tokens['text.primary'],
            backgroundColor: 'transparent',
          }}
        />
        <Box component="span" aria-hidden="true" sx={{ display: 'inline-flex' }}>
          <Kbd>Esc</Kbd>
        </Box>
      </Box>

      <Box sx={{ overflowY: 'auto', maxHeight: '60vh', paddingBlock: 1 }}>
        {showList ? (
          <Box
            id={listboxId}
            role="listbox"
            aria-label={t('admin:palette.resultsLabel')}
            aria-busy={state.busy}
          >
            {groups.map(({ group, options }) => (
              <PaletteGroupList key={group} group={group} listboxId={listboxId}>
                {options.map((option) => (
                  <PaletteRow
                    key={option.key}
                    id={optionId(option)}
                    option={option}
                    active={option === active}
                    onHover={() => {
                      setActiveKey(option.key);
                    }}
                    onChoose={() => {
                      choose(option);
                    }}
                  />
                ))}
              </PaletteGroupList>
            ))}
          </Box>
        ) : null}

        {state.empty ? (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, padding: 4 }}>
            <Typography variant="bodyStrong" component="p" sx={{ margin: 0 }}>
              {t('admin:palette.noResults.title', { query })}
            </Typography>
            <Typography
              variant="body2"
              component="p"
              sx={{ margin: 0, color: tokens['text.secondary'] }}
            >
              {t('admin:palette.noResults.hint')}
            </Typography>
            <Box
              component="button"
              type="button"
              onClick={() => {
                onGo(`/tickets?q=${encodeURIComponent(query)}`);
              }}
              sx={linkButton(tokens['text.link'], tokens['border.focus'])}
            >
              {t('admin:palette.noResults.action')}
            </Box>
          </Box>
        ) : null}

        {state.searchFailed ? (
          <Notice message={t('admin:palette.searchFailed')} onRetry={state.retry} />
        ) : (
          state.failedSections.map((section) => (
            <Notice
              key={section}
              message={t('admin:palette.failed', { section: t(`admin:palette.groups.${section}`) })}
              onRetry={state.retry}
            />
          ))
        )}

        {session.user.role === 'viewer' && query !== '' ? (
          <Typography
            variant="caption"
            component="p"
            sx={{ margin: 0, paddingInline: 4, paddingBlock: 2, color: tokens['text.secondary'] }}
          >
            {t('admin:palette.viewerNote')}
          </Typography>
        ) : null}
      </Box>

      <Box component="span" role="status" sx={visuallyHidden}>
        {countText}
      </Box>

      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 5,
          paddingInline: 4,
          paddingBlock: 2,
          borderBlockStart: `1px solid ${tokens['border.default']}`,
          fontSize: 12,
          color: tokens['text.secondary'],
        }}
      >
        <Hint keys={['↑', '↓']} label={t('admin:palette.footer.move')} />
        <Hint keys={['Enter']} label={t('admin:palette.footer.open')} />
      </Box>
    </>
  );
}

const linkButton = (color: string, focus: string) => ({
  alignSelf: 'flex-start',
  padding: 0,
  border: 0,
  background: 'none',
  font: 'inherit',
  fontSize: 14,
  color,
  cursor: 'pointer',
  textDecoration: 'underline',
  '&:focus-visible': { outline: `2px solid ${focus}`, outlineOffset: 2, borderRadius: '2px' },
});

function Hint({
  keys,
  label,
}: {
  readonly keys: readonly string[];
  readonly label: string;
}): ReactNode {
  return (
    <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
      <Box component="span" dir="ltr" sx={{ display: 'inline-flex', gap: 1 }}>
        {keys.map((key) => (
          <Kbd key={key}>{key}</Kbd>
        ))}
      </Box>
      {label}
    </Box>
  );
}

function Notice({
  message,
  onRetry,
}: {
  readonly message: string;
  readonly onRetry: () => void;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();

  return (
    <Box
      role="status"
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 3,
        marginInline: 2,
        marginBlockStart: 1,
        padding: 3,
        borderRadius: '6px',
        backgroundColor: tokens['bg.muted'],
        color: tokens['text.secondary'],
        fontSize: 13,
      }}
    >
      <Box component="span" sx={{ flex: 1 }}>
        {message}
      </Box>
      <Box
        component="button"
        type="button"
        onClick={onRetry}
        sx={linkButton(tokens['text.link'], tokens['border.focus'])}
      >
        {t('admin:palette.retry')}
      </Box>
    </Box>
  );
}

function PaletteGroupList({
  group,
  listboxId,
  children,
}: {
  readonly group: PaletteOption['group'];
  readonly listboxId: string;
  readonly children: ReactNode;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const headingId = `${listboxId}-group-${group}`;

  if (group === 'search') {
    return <Box role="group">{children}</Box>;
  }

  return (
    <Box role="group" aria-labelledby={headingId}>
      <Box
        id={headingId}
        role="presentation"
        sx={{
          paddingInline: 3,
          paddingBlockStart: 2,
          paddingBlockEnd: 1,
          fontSize: 12,
          fontWeight: 500,
          color: tokens['text.secondary'],
        }}
      >
        {t(`admin:palette.groups.${group}`)}
      </Box>
      {children}
    </Box>
  );
}

function PaletteRow({
  id,
  option,
  active,
  onHover,
  onChoose,
}: {
  readonly id: string;
  readonly option: PaletteOption;
  readonly active: boolean;
  readonly onHover: () => void;
  readonly onChoose: () => void;
}): ReactNode {
  const tokens = useSemanticTokens();
  const Icon = option.icon;

  return (
    <Box
      id={id}
      role="option"
      aria-selected={active}
      // The input keeps focus; a press on a row must not take it.
      onMouseDown={(event: React.MouseEvent) => {
        event.preventDefault();
      }}
      onMouseMove={onHover}
      onClick={onChoose}
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 3,
        minHeight: 36,
        paddingInline: 3,
        marginInline: 1.5,
        borderRadius: '6px',
        cursor: 'pointer',
        backgroundColor: active ? tokens['bg.muted'] : 'transparent',
      }}
    >
      <Box
        component="span"
        aria-hidden="true"
        sx={{ display: 'inline-flex', flexShrink: 0, color: tokens['text.secondary'] }}
      >
        <Icon size={16} />
      </Box>
      <Box component="span" sx={{ minWidth: 0, display: 'flex', alignItems: 'baseline', gap: 3 }}>
        <Box component="bdi" sx={{ whiteSpace: 'nowrap', fontWeight: option.enter ? 500 : 400 }}>
          {option.primary}
        </Box>
        {option.secondary === undefined ? null : (
          <Box
            component="bdi"
            sx={{
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              color: tokens['text.secondary'],
            }}
          >
            {option.secondary}
          </Box>
        )}
      </Box>
      {option.keys === undefined && option.enter !== true ? null : (
        <Box
          component="span"
          sx={{ marginInlineStart: 'auto', flexShrink: 0, display: 'inline-flex' }}
        >
          {option.keys === undefined ? <Kbd>Enter</Kbd> : <KeyCombo keys={option.keys} compact />}
        </Box>
      )}
    </Box>
  );
}
