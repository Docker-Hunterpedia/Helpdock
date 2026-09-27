import { Box, Typography } from '@mui/material';
import { useMutation } from '@tanstack/react-query';
import type { FormEvent, ReactNode } from 'react';
import { useT } from '../../../app/i18n.js';
import { useSemanticTokens } from '../../../app/tokens.js';
import { useToast } from '../../../ui/toasts.tsx';

/**
 * The card every section of `Admin/Channels · Outgoing email` is drawn in: a
 * heading and caption inside the card's top, the body, and an optional footer
 * on `bg.canvas` holding Discard and Save (artboard `AdminEmailOutgoing`).
 * A section with a footer is a form, so Enter in a field saves it.
 */
export function SectionCard({
  id,
  heading,
  caption,
  aside,
  footer,
  onSubmit,
  children,
}: {
  readonly id: string;
  readonly heading: string;
  readonly caption: string;
  /** Beside the heading: a count badge, a "Retry all". */
  readonly aside?: ReactNode;
  readonly footer?: ReactNode;
  readonly onSubmit?: (event: FormEvent) => void;
  readonly children: ReactNode;
}): ReactNode {
  const tokens = useSemanticTokens();
  const headingId = `${id}-heading`;

  return (
    <Box
      component="section"
      aria-labelledby={headingId}
      sx={{
        borderRadius: '10px',
        border: `1px solid ${tokens['border.default']}`,
        backgroundColor: tokens['bg.surface'],
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
      }}
    >
      <Box
        component={onSubmit === undefined ? 'div' : 'form'}
        noValidate
        {...(onSubmit === undefined ? {} : { onSubmit })}
        sx={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}
      >
        <Box
          sx={{
            paddingBlock: 4,
            paddingInline: 5,
            display: 'flex',
            alignItems: 'baseline',
            gap: 3,
            flexWrap: 'wrap',
            borderBlockEnd: `1px solid ${tokens['border.default']}`,
          }}
        >
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: '2px', flex: '1 1 240px' }}>
            <Typography id={headingId} variant="h3" component="h2" sx={{ fontSize: 16 }}>
              {heading}
            </Typography>
            <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: 13 }}>
              {caption}
            </Typography>
          </Box>
          {aside}
        </Box>

        <Box sx={{ padding: 5, display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
          {children}
        </Box>

        {footer === undefined ? null : (
          <Box
            sx={{
              paddingBlock: 3,
              paddingInline: 5,
              display: 'flex',
              justifyContent: 'flex-end',
              gap: 2,
              borderBlockStart: `1px solid ${tokens['border.default']}`,
              backgroundColor: tokens['bg.canvas'],
              borderEndStartRadius: '10px',
              borderEndEndRadius: '10px',
            }}
          >
            {footer}
          </Box>
        )}
      </Box>
    </Box>
  );
}

/**
 * One save, wired the same way in every section: run it, refresh what it
 * changed, and say so — or say the one sentence for "that did not work".
 */
export function useEmailAction<TInput, TResult>(
  run: (input: TInput) => Promise<TResult>,
  success: string,
  refresh: (result: TResult) => Promise<void> | void,
) {
  const t = useT();
  const toast = useToast();

  return useMutation({
    mutationFn: run,
    onSuccess: async (result: TResult) => {
      await refresh(result);
      toast({ tone: 'success', message: success });
    },
    onError: () => {
      toast({ tone: 'danger', message: t('channels:actionFailed') });
    },
  });
}
