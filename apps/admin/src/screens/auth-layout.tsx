import { Box, Link, Paper, Typography } from '@mui/material';
import type { ReactNode } from 'react';
import { otherLocale, useT } from '../app/i18n.js';
import { usePreferences } from '../app/providers.tsx';
import { useSemanticTokens } from '../app/tokens.js';
import { BrandMark } from '../ui/brand-mark.tsx';

/**
 * A link to the one other language, labelled in that language's own name
 * (DESIGN §6.7). It is a real control rather than a select: there are two.
 */
export function LanguageLink(): ReactNode {
  const t = useT();
  const { locale, setLocale } = usePreferences();
  const other = otherLocale(locale);

  return (
    <Link
      component="button"
      type="button"
      variant="caption"
      lang={other}
      onClick={() => {
        setLocale(other);
      }}
      aria-label={t('common:language.switchTo', { language: t(`common:language.${other}`) })}
    >
      {t(`common:language.${other}`)}
    </Link>
  );
}

export interface AuthLayoutProps {
  readonly title: string;
  readonly subtitle: string;
  /** 400 on the sign-in artboard, 520 on `Admin/TOTP`. */
  readonly width?: number;
  readonly children: ReactNode;
  /** The row under the card: the two-factor note, banners, links. */
  readonly footer?: ReactNode;
}

/**
 * The centred column the artboards `Admin/Login`, `Admin/Login-AR` and
 * `Admin/TOTP` share: mark and wordmark, h1, caption, then the bordered card.
 */
export function AuthLayout({
  title,
  subtitle,
  width = 400,
  children,
  footer,
}: AuthLayoutProps): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();

  return (
    <Box
      component="main"
      sx={{
        minHeight: '100dvh',
        backgroundColor: tokens['bg.canvas'],
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        padding: 6,
      }}
    >
      <Box
        sx={{ width: '100%', maxWidth: width, display: 'flex', flexDirection: 'column', gap: 6 }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 3 }}>
          <BrandMark initial="H" />
          <Typography variant="h3" component="p">
            {t('common:appName')}
          </Typography>
        </Box>

        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <Typography variant="h1" component="h1">
            {title}
          </Typography>
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            {subtitle}
          </Typography>
        </Box>

        <Paper
          elevation={0}
          sx={{
            borderRadius: '10px',
            border: `1px solid ${tokens['border.default']}`,
            backgroundColor: tokens['bg.surface'],
            padding: 6,
          }}
        >
          {children}
        </Paper>

        {footer}
      </Box>
    </Box>
  );
}
