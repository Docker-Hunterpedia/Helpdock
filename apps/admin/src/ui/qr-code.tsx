import { Box, Typography } from '@mui/material';
import { type ReactNode, useMemo } from 'react';
import { useT } from '../app/i18n.js';
import { useSemanticTokens } from '../app/tokens.js';
import { encodeQr, QR_QUIET_ZONE, QrTooLongError, qrPath } from './qr-encode.js';

/**
 * The QR code on the enrolment screen, drawn as one SVG path.
 *
 * SVG rather than a canvas or a server-rendered image, because a QR code is
 * squares: it scales to any size without blurring, it prints, and the modules
 * land on whole pixels at every zoom level, which is what a camera needs. It is
 * also the only form that costs no round trip — the `otpauth://` URI is a
 * credential, and asking a server to draw it would put it in a second place.
 *
 * `shape-rendering: crispEdges` keeps the browser from anti-aliasing the module
 * edges into grey, which is the one thing that makes a small code unreadable.
 *
 * The colours are the theme's own: a QR reader needs contrast between the
 * modules and the background, not black and white in particular, and hard-coded
 * black on a dark background would be the wrong way round.
 */
export function QrCode({
  value,
  size = 200,
  label,
}: {
  readonly value: string;
  /** Rendered size in pixels; the module grid scales to fit. */
  readonly size?: number;
  /** What a screen reader announces. The key text is beside it in the markup. */
  readonly label: string;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();

  const drawing = useMemo(() => {
    try {
      const matrix = encodeQr(value);

      return { path: qrPath(matrix), modules: matrix.length };
    } catch (error) {
      /* c8 ignore next 3 -- an otpauth URI is far inside the capacity. */
      if (error instanceof QrTooLongError) {
        return null;
      }
      throw error;
    }
  }, [value]);

  /* c8 ignore next 7 -- unreachable for an otpauth URI; here so a failure is a sentence. */
  if (drawing === null) {
    return (
      <Typography variant="body2" sx={{ color: 'text.secondary' }}>
        {t('auth:enrolment.step1.manualLabel')}
      </Typography>
    );
  }

  const extent = drawing.modules + QR_QUIET_ZONE * 2;

  return (
    <Box
      sx={{
        width: size,
        height: size,
        padding: 0,
        borderRadius: '10px',
        border: `1px solid ${tokens['border.default']}`,
        backgroundColor: tokens['bg.surface'],
      }}
    >
      <svg
        role="img"
        aria-label={label}
        viewBox={`0 0 ${String(extent)} ${String(extent)}`}
        width={size}
        height={size}
        shapeRendering="crispEdges"
      >
        <rect width={extent} height={extent} fill={tokens['bg.surface']} />
        <g transform={`translate(${String(QR_QUIET_ZONE)}, ${String(QR_QUIET_ZONE)})`}>
          <path d={drawing.path} fill={tokens['text.primary']} />
        </g>
      </svg>
    </Box>
  );
}
