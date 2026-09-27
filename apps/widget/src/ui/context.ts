import { createContext, type FunctionComponent } from 'preact';
import { useContext, useEffect, useState } from 'preact/hooks';
import type { Translate } from '../i18n/translator.js';
import type { WidgetController, WidgetState } from '../state/controller.js';
import type { WidgetLocale } from '../transport/types.js';

export interface WidgetContextValue {
  readonly controller: WidgetController;
  readonly t: Translate;
  readonly locale: WidgetLocale;
}

export const WidgetContext = createContext<WidgetContextValue | null>(null);

export function useWidget(): WidgetContextValue {
  const value = useContext(WidgetContext);
  if (!value) {
    throw new Error('useWidget outside <WidgetContext.Provider>');
  }
  return value;
}

export function useWidgetState(): WidgetState {
  const { controller } = useWidget();
  const [state, setState] = useState(controller.state);
  useEffect(() => {
    setState(controller.state);
    return controller.subscribe(setState);
  }, [controller]);
  return state;
}

/**
 * Preact without `compat` has no `lazy`/`Suspense`; this is the part of them
 * the widget needs: load a chunk the first time a screen asks for it (D §14).
 */
export function useLazy<P>(
  load: () => Promise<FunctionComponent<P>>,
  enabled = true,
): FunctionComponent<P> | null {
  const [component, setComponent] = useState<{ value: FunctionComponent<P> } | null>(null);
  useEffect(() => {
    if (!enabled || component) {
      return;
    }
    let live = true;
    load().then(
      (value) => live && setComponent({ value }),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [enabled, component, load]);
  return component?.value ?? null;
}
