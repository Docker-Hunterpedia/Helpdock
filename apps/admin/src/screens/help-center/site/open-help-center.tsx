import { Box, Typography } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { LoaderCircle } from 'lucide-react';
import { type ReactNode, useEffect } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useT } from '../../../app/i18n.js';
import { helpCenterRoute } from '../../../app/route-paths.js';
import { useHelpCenterApi } from '../../../help-center/context.tsx';
import { AlertBanner } from '../../../ui/alert-banner.tsx';
import { openRequestOf } from './site-draft.js';

/** Where the browser goes once the pass is in hand. The fixture's is a page that does not exist. */
export type Navigate = (url: string) => void;

const assign: Navigate = (url) => {
  window.location.replace(url);
};

/**
 * `/help-center/open` (M5-03): the step between the admin and the help center
 * on the brand's own host. It asks the api for a staff pass — the session is
 * the admin's, so an expired one signs in first and comes back here — and
 * replaces itself with the help center, which exchanges the pass for its own
 * staff cookie. "View help center", "Preview" and the internal-only wall's
 * sign-in all link here.
 *
 * It has no artboard because it has nothing to show: a status line while the
 * pass is asked for, and the DESIGN §6.4 Banner if it cannot be.
 */
export function OpenHelpCenter({ navigate = assign }: { readonly navigate?: Navigate }): ReactNode {
  const t = useT();
  const api = useHelpCenterApi();
  const [search] = useSearchParams();
  const target = openRequestOf(search);
  const pass = useQuery({
    queryKey: ['help-center', 'staff-pass', search.toString()],
    queryFn: () =>
      target === null
        ? Promise.reject(new Error('bad address'))
        : api.staffPass(target.brandId, target.request),
    retry: false,
    gcTime: 0,
    staleTime: Number.POSITIVE_INFINITY,
  });

  useEffect(() => {
    if (pass.data !== undefined) {
      navigate(pass.data.url);
    }
  }, [navigate, pass.data]);

  if (pass.isError) {
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 4, maxWidth: 720 }}>
        <AlertBanner tone="danger">{t('helpCenter:open.failed')}</AlertBanner>
        <Link to={helpCenterRoute('articles')}>{t('helpCenter:open.back')}</Link>
      </Box>
    );
  }
  return (
    <Typography
      role="status"
      sx={{ display: 'inline-flex', alignItems: 'center', gap: 2, color: 'text.secondary' }}
    >
      <LoaderCircle size={16} aria-hidden="true" />
      {t('helpCenter:open.opening')}
    </Typography>
  );
}
