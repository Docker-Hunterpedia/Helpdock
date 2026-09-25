import { Box, Snackbar, Typography } from '@mui/material';
import { CircleAlert, CircleCheck } from 'lucide-react';
import { createContext, type ReactNode, useCallback, useContext, useState } from 'react';
import { useSemanticTokens } from '../app/tokens.js';

/**
 * DESIGN §6.4 Toast: `bg.inverse`, 13 px, an icon in the status hue,
 * auto-dismiss after six seconds, stacked at the bottom inline-end — which is
 * the bottom *left* in Arabic, because the anchor is logical.
 *
 * One at a time. A stack of four confirmations for four clicks is noise, and
 * the last one is the one that matters; a new toast replaces the one on screen.
 *
 * `role="status"` rather than `role="alert"`: these confirm something the
 * person just did, so they belong in the polite queue and must not interrupt
 * whatever a screen reader is in the middle of.
 */

const AUTO_DISMISS_MS = 6000;

export type ToastTone = 'success' | 'danger';

export interface Toast {
  readonly message: string;
  readonly tone: ToastTone;
}

export type ShowToast = (toast: Toast) => void;

const ToastContext = createContext<ShowToast | null>(null);

export function useToast(): ShowToast {
  const show = useContext(ToastContext);
  if (!show) {
    throw new Error('useToast needs a <ToastProvider> above it');
  }

  return show;
}

export function ToastProvider({ children }: { readonly children: ReactNode }): ReactNode {
  const tokens = useSemanticTokens();
  const [toast, setToast] = useState<Toast | null>(null);

  const show = useCallback<ShowToast>((next) => {
    setToast(next);
  }, []);

  const Icon = toast?.tone === 'danger' ? CircleAlert : CircleCheck;

  return (
    <ToastContext.Provider value={show}>
      {children}
      <Snackbar
        open={toast !== null}
        autoHideDuration={AUTO_DISMISS_MS}
        onClose={(_event, reason) => {
          // A click somewhere else is not a dismissal. DESIGN §6.4 gives a
          // toast six seconds and nothing else, and MUI's `clickaway` costs
          // more than the toast it closes: its document listener runs *after*
          // the React handler that raised the next one, so confirming a dialog
          // while a toast is up would set the new message and then clear it —
          // and the action would look as though it had not happened.
          if (reason !== 'clickaway') {
            setToast(null);
          }
        }}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        // Logical, so the stack sits at the inline end in both directions.
        sx={{ insetInlineEnd: 24, insetInlineStart: 'auto', right: 'auto' }}
      >
        <Box
          role="status"
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 2,
            paddingInline: 4,
            paddingBlock: 3,
            borderRadius: '8px',
            backgroundColor: tokens['bg.inverse'],
            color: tokens['text.inverse'],
            maxWidth: 420,
          }}
        >
          <Icon
            size={16}
            aria-hidden="true"
            color={toast?.tone === 'danger' ? tokens['status.danger'] : tokens['status.success']}
            style={{ flexShrink: 0 }}
          />
          <Typography variant="body2" sx={{ color: 'inherit', fontSize: 13 }}>
            {toast?.message ?? ''}
          </Typography>
        </Box>
      </Snackbar>
    </ToastContext.Provider>
  );
}
