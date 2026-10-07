import type { AiCitationView } from '@helpdock/schemas';
import { Box, Link, Typography } from '@mui/material';
import { BookOpen, Globe, Lock } from 'lucide-react';
import type { ReactNode } from 'react';
import { useT } from '../../../app/i18n.js';
import { useSemanticTokens } from '../../../app/tokens.js';

/**
 * DESIGN §6.3 CitationList (M7-06, `Admin/Ticket-AI`): under the answer, a
 * "Sources" caption and an `ol` of the mono number, a book icon, the title as
 * a link when it has an address, then its visibility as an icon and a word.
 */
export function CitationList({
  citations,
  idPrefix,
}: {
  readonly citations: readonly AiCitationView[];
  /** Makes each row an anchor the `[n]` in the text can point at. */
  readonly idPrefix: string;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const labelId = `${idPrefix}-sources`;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, marginBlockStart: 3 }}>
      <Typography
        id={labelId}
        variant="caption"
        component="p"
        sx={{ color: 'text.secondary', fontWeight: 500 }}
      >
        {t('tickets:autoReply.sources')}
      </Typography>
      <Box
        component="ol"
        aria-labelledby={labelId}
        sx={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column' }}
      >
        {citations.map((citation) => (
          <Box
            component="li"
            key={citation.marker}
            id={`${idPrefix}-source-${citation.marker}`}
            sx={{ display: 'flex', alignItems: 'center', gap: 2, fontSize: 13, lineHeight: '20px' }}
          >
            <Typography variant="mono" component="span" sx={{ color: 'text.secondary' }}>
              {citation.marker}
            </Typography>
            <BookOpen size={14} aria-hidden="true" />
            {citation.url === null ? (
              <bdi>{citation.title}</bdi>
            ) : (
              <Link href={citation.url} target="_blank" rel="noopener noreferrer">
                <bdi>{citation.title}</bdi>
              </Link>
            )}
            <Box
              component="span"
              sx={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 1,
                color:
                  citation.visibility === 'internal'
                    ? tokens['status.warning.text']
                    : 'text.secondary',
              }}
            >
              {citation.visibility === 'internal' ? (
                <Lock size={14} aria-hidden="true" />
              ) : (
                <Globe size={14} aria-hidden="true" />
              )}
              {t(`tickets:autoReply.${citation.visibility}`)}
            </Box>
          </Box>
        ))}
      </Box>
    </Box>
  );
}
