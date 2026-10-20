import { type Locale, NAMESPACES } from '@helpdock/i18n';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router';
import { otherLocale, useT } from '../app/i18n.js';
import type { ThemePreference } from '../app/preferences.js';
import { usePreferences } from '../app/providers.tsx';
import { ticketIdFromPath } from '../app/route-paths.js';
import { currentBrand, useSession, useSwitchBrand } from '../auth/session.tsx';
import { useKeyboard } from '../keyboard/keyboard-provider.tsx';
import type { KeyStroke } from '../keyboard/keys.js';
import { isSingleKey, shortcutById } from '../keyboard/registry.js';
import { useToast } from '../ui/toasts.tsx';
import { PALETTE_SHORTCUT_ACTIONS } from './actions.js';

/** One thing the palette can do, already filtered to this person and this screen. */
export interface PaletteAction {
  readonly id: string;
  readonly label: string;
  /** Every wording it can be found by, in both languages. */
  readonly texts: readonly string[];
  /** Drawn at the row's end: the shortcut's keys, only while they answer. */
  readonly keys?: readonly KeyStroke[];
  /** Offered in the empty palette: it belongs to the screen the person is on. */
  readonly suggested: boolean;
  readonly run: () => void;
}

const THEMES: readonly ThemePreference[] = ['light', 'dark', 'auto'];

/**
 * The actions of the palette (M14-05): the registry shortcuts a screen has
 * attached and the person may use, then the ones that are not shortcuts —
 * copy a ticket's link, switch brand, language and theme.
 *
 * Computed when the palette opens, from the handlers attached at that moment:
 * opening the palette does not detach a screen's handlers, so "Reply" is
 * there exactly while a ticket is open.
 */
export function usePaletteActions(open: boolean): readonly PaletteAction[] {
  const t = useT();
  const { i18n } = useTranslation(NAMESPACES);
  const { pathname } = useLocation();
  const session = useSession();
  const { locale, setLocale, themePreference, setThemePreference } = usePreferences();
  const switchBrand = useSwitchBrand();
  const toast = useToast();
  const { singleKeys, isAvailable, run } = useKeyboard();
  const brand = currentBrand(session);

  return useMemo(() => {
    if (!open) {
      return [];
    }
    const textsOf = (key: string): string[] =>
      (['en', 'ar'] as const).map((lng: Locale) => String(i18n.getFixedT(lng)(key as never)));
    const say = (key: string): string => String(t(key as never));

    const fromShortcuts = PALETTE_SHORTCUT_ACTIONS.filter((id) => isAvailable(id)).map(
      (id): PaletteAction => {
        const shortcut = shortcutById(id);
        const key = `admin:palette.actions.${id}`;
        return {
          id,
          label: say(key),
          texts: textsOf(key),
          ...(!singleKeys && isSingleKey(shortcut) ? {} : { keys: shortcut.keys }),
          suggested: true,
          run: () => {
            run(id);
          },
        };
      },
    );

    const ticketOpen = ticketIdFromPath(pathname) !== null;
    const copyLink: PaletteAction[] = ticketOpen
      ? [
          {
            id: 'copyLink',
            label: say('admin:palette.actions.copyLink'),
            texts: textsOf('admin:palette.actions.copyLink'),
            suggested: true,
            run: () => {
              void navigator.clipboard?.writeText(window.location.href).then(() => {
                toast({ tone: 'success', message: say('admin:palette.actions.linkCopied') });
              });
            },
          },
        ]
      : [];

    const brands = session.brands
      .filter((candidate) => candidate.id !== brand.id)
      .map(
        (candidate): PaletteAction => ({
          id: `brand:${candidate.id}`,
          label: t('admin:palette.actions.switchBrand', { brand: candidate.name }),
          texts: [t('admin:palette.actions.switchBrand', { brand: candidate.name })],
          suggested: false,
          run: () => {
            switchBrand(candidate.id);
          },
        }),
      );

    const other = otherLocale(locale);
    const language = new Intl.DisplayNames([other], { type: 'language' }).of(other) ?? other;
    const languageAction: PaletteAction = {
      id: 'language',
      label: t('admin:palette.actions.language', { language }),
      texts: [
        t('admin:palette.actions.language', { language }),
        ...textsOf('admin:palette.actions.language'),
      ],
      suggested: false,
      run: () => {
        setLocale(other);
      },
    };

    const themes = THEMES.filter((theme) => theme !== themePreference).map(
      (theme): PaletteAction => ({
        id: `theme:${theme}`,
        label: say(`admin:palette.actions.theme.${theme}`),
        texts: textsOf(`admin:palette.actions.theme.${theme}`),
        suggested: false,
        run: () => {
          setThemePreference(theme);
        },
      }),
    );

    return [...fromShortcuts, ...copyLink, ...brands, languageAction, ...themes];
  }, [
    open,
    i18n,
    t,
    pathname,
    session.brands,
    brand.id,
    locale,
    themePreference,
    singleKeys,
    isAvailable,
    run,
    setLocale,
    setThemePreference,
    switchBrand,
    toast,
  ]);
}
