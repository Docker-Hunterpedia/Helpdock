import { Box, IconButton, Typography } from '@mui/material';
import { Copy } from 'lucide-react';
import { Fragment, type ReactNode } from 'react';
import { useT } from '../../../app/i18n.js';
import { useToast } from '../../../ui/toasts.tsx';

/**
 * One OAuth redirect URL in the Settings aside, with a Copy button named after
 * what it copies, as the SSO screen's public values have.
 *
 * The address may wrap only after a `/`, so it never breaks inside a word
 * ("oauth/g / oogle/callback"); a segment wider than the card still wraps
 * rather than overflowing it.
 */
export function RedirectUrl({
  provider,
  url,
}: {
  readonly provider: 'google' | 'microsoft' | 'github';
  readonly url: string;
}): ReactNode {
  const t = useT();
  const toast = useToast();

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(url);
      toast({ tone: 'success', message: t('settings:aside.redirectUrls.copied') });
    } catch {
      // The Clipboard API refuses for reasons the page cannot tell apart
      // (permission, focus, an insecure origin); every one leaves the same
      // way out, which is selecting the text.
      toast({ tone: 'danger', message: t('settings:aside.redirectUrls.copyError') });
    }
  };

  return (
    <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1 }}>
      <Typography
        variant="mono"
        component="bdi"
        dir="ltr"
        sx={{ fontSize: 12, flex: 1, minWidth: 0, overflowWrap: 'break-word' }}
      >
        {url.split('/').map((part, index, parts) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a URL's segments are positional and may repeat.
          <Fragment key={index}>
            {part}
            {index < parts.length - 1 ? (
              <>
                /<wbr />
              </>
            ) : null}
          </Fragment>
        ))}
      </Typography>
      <IconButton
        aria-label={t('settings:aside.redirectUrls.copy', {
          provider: t(`settings:oauth.${provider}`),
        })}
        onClick={() => {
          void copy();
        }}
      >
        <Copy size={16} aria-hidden="true" />
      </IconButton>
    </Box>
  );
}
