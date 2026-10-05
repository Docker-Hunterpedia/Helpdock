import { Box, Link as MuiLink, Typography } from '@mui/material';
import { ExternalLink, MapPin } from 'lucide-react';
import type { ReactNode } from 'react';
import { useT } from '../../../app/i18n.js';

/**
 * DESIGN §6.3 LocationLine (M6-03, `Admin/Ticket-Telegram`): a location a
 * customer shared, as text — the pin, "Location", the coordinates and an
 * "Open map" link. No embedded map and no request to a map service until the
 * agent follows the link.
 *
 * The api files a location as a paragraph of the message body ("Location:
 * 52.52, 13.405" and an OpenStreetMap link, in the contact's language, so the
 * text is right wherever it is read); {@link splitLocation} finds that
 * paragraph in the sanitised HTML and lifts it out, so the thread draws the
 * line instead of the raw link.
 */

export interface SharedLocation {
  readonly latitude: string;
  readonly longitude: string;
  readonly url: string;
}

const MAP_LINK =
  /^https:\/\/www\.openstreetmap\.org\/\?mlat=(-?\d+(?:\.\d+)?)&mlon=(-?\d+(?:\.\d+)?)(?:#.*)?$/;

/** The body without its location paragraph, and the location; undefined when there is none. */
export const splitLocation = (
  bodyHtml: string,
): { readonly html: string; readonly location: SharedLocation } | undefined => {
  if (!bodyHtml.includes('openstreetmap.org')) {
    return undefined;
  }
  const document = new DOMParser().parseFromString(bodyHtml, 'text/html');
  for (const anchor of document.body.querySelectorAll('a[href]')) {
    const url = anchor.getAttribute('href') ?? '';
    const match = MAP_LINK.exec(url);
    if (match === null) {
      continue;
    }
    (anchor.closest('p') ?? anchor).remove();
    return {
      html: document.body.innerHTML,
      location: { latitude: match[1] ?? '', longitude: match[2] ?? '', url },
    };
  }
  return undefined;
};

export function LocationLine({ location }: { readonly location: SharedLocation }): ReactNode {
  const t = useT();
  const coordinates = `${location.latitude}, ${location.longitude}`;

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap', fontSize: 14 }}>
      <MapPin size={14} aria-hidden="true" />
      <span>{t('tickets:telegram.location.label')}</span>
      <Typography variant="mono" component="span" sx={{ fontSize: 13 }}>
        <bdi>{coordinates}</bdi>
      </Typography>
      <MuiLink
        href={location.url}
        target="_blank"
        rel="noopener noreferrer nofollow"
        aria-label={t('tickets:telegram.location.openLabel', { coordinates })}
        sx={{ display: 'inline-flex', alignItems: 'center', gap: 1, fontSize: 13 }}
      >
        {t('tickets:telegram.location.open')}
        <ExternalLink size={14} aria-hidden="true" className="mirror-in-rtl" />
      </MuiLink>
    </Box>
  );
}
