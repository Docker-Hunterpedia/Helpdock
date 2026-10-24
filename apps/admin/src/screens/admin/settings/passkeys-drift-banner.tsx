import { monoFontStyle } from '@helpdock/ui';
import { Box } from '@mui/material';
import { Fragment, type ReactNode } from 'react';
import { useT } from '../../../app/i18n.js';
import { AlertBanner } from '../../../ui/alert-banner.tsx';

/** Sentinels the catalog's `{{…}}` slots are filled with, so each can be wrapped as a left-to-right run. */
export const SLOTS = ['', '', ''] as const;

/** `text` with the sentinel slots replaced by `parts`, in order of appearance. */
export function fillSlots(text: string, parts: Readonly<Record<string, ReactNode>>): ReactNode {
  return text.split(new RegExp(`(${SLOTS.join('|')})`)).map((piece, index) => (
    // The pieces are positional and never reorder.
    // biome-ignore lint/suspicious/noArrayIndexKey: a split sentence has no other identity.
    <Fragment key={index}>{parts[piece] ?? piece}</Fragment>
  ));
}

const host = (value: string): ReactNode => (
  <bdi dir="ltr" style={{ ...monoFontStyle }}>
    {value}
  </bdi>
);

/**
 * `passkeys-rp-changed` (M18-06): the passkeys were made for `from`, the install
 * now runs at `to`. Both hosts are left-to-right runs inside a right-to-left
 * sentence. Settings › Authentication and the System page draw the same words.
 */
export function PasskeysDriftBanner({
  from,
  to,
  children,
}: {
  readonly from: string;
  readonly to: string;
  readonly children?: ReactNode;
}): ReactNode {
  const t = useT();
  return (
    <AlertBanner tone="warning">
      <Box component="strong" sx={{ display: 'block', fontWeight: 600 }}>
        {t('settings:passkeys.pausedTitle')}
      </Box>
      {fillSlots(t('settings:passkeys.pausedBody', { from: SLOTS[0], to: SLOTS[1] }), {
        [SLOTS[0]]: host(from),
        [SLOTS[1]]: host(to),
      })}
      {children}
    </AlertBanner>
  );
}
