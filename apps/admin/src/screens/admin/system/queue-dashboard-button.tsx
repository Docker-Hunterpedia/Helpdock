import { Button } from '@mui/material';
import { useMutation } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import type { ReactNode } from 'react';
import { useT } from '../../../app/i18n.js';
import { useToast } from '../../../ui/toasts.tsx';
import type { SystemApi } from './system-api.js';

/**
 * "Open queue dashboard" (M8-05, ADR 0016): asks for a one-use pass and opens
 * Bull Board with it in a new tab.
 *
 * The tab is opened before the request, while the click still counts as the
 * person's gesture; a window opened after an `await` is what popup blockers
 * stop. It starts blank, loses its `opener` so the board cannot reach back into
 * the admin, and is closed again if the pass is refused.
 */
export function QueueDashboardButton({ api }: { readonly api: SystemApi }): ReactNode {
  const t = useT();
  const toast = useToast();

  const open = useMutation({
    mutationFn: async (tab: Window | null) => {
      try {
        const url = await api.queueBoardPass();
        if (tab === null) {
          window.location.assign(url);
          return;
        }
        tab.location.assign(url);
      } catch (error) {
        tab?.close();
        throw error;
      }
    },
    onError: () => {
      toast({ tone: 'danger', message: t('system:queueBoard.failed') });
    },
  });

  return (
    <Button
      variant="outlined"
      size="small"
      startIcon={<ExternalLink size={16} aria-hidden="true" />}
      disabled={open.isPending}
      onClick={() => {
        const tab = window.open('about:blank', '_blank');
        if (tab !== null) {
          tab.opener = null;
        }
        open.mutate(tab);
      }}
    >
      {t('system:queueBoard.open')}
    </Button>
  );
}
