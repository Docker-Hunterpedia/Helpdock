import type { AssistCitation } from '@helpdock/schemas';
import { Box, Link, Typography } from '@mui/material';
import { BookOpen, FileText, Globe, Lock } from 'lucide-react';
import { type ReactNode, useId } from 'react';
import { useT } from '../../../app/i18n.js';
import { useSemanticTokens } from '../../../app/tokens.js';

/**
 * DESIGN §6.3 CitationList as agent assist shows it (M7-05); auto-reply's,
 * which cites public sources only, is `../ai/citation-list.tsx`. Here: a
 * "Sources" caption and an ordered list — the mono number, a book or file
 * icon, the title (a link when the source has one), and its visibility as an
 * icon and a word. An internal source carries the "Internal" chip and
 * "removed on Insert", because Insert strips it from a public reply
 * (DOMAIN-RULES §5).
 */
export function AssistCitationList({
  citations,
  size = 13,
}: {
  readonly citations: readonly AssistCitation[];
  /** 12 inside an AISuggestionCard, 13 elsewhere. */
  readonly size?: 12 | 13;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const headingId = useId();

  if (citations.length === 0) {
    return null;
  }

  return (
    <Box>
      <Typography
        id={headingId}
        variant="caption"
        component="p"
        sx={{ fontWeight: 500, color: 'text.secondary', marginBlockEnd: 1 }}
      >
        {t('tickets:assist.sources')}
      </Typography>
      <Box
        component="ol"
        aria-labelledby={headingId}
        sx={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 1 }}
      >
        {citations.map((citation) => {
          const Icon = citation.sourceKind === 'article' ? BookOpen : FileText;
          const title =
            citation.page === null
              ? citation.title
              : t('tickets:assist.titleWithPage', { title: citation.title, page: citation.page });
          return (
            <Box
              component="li"
              key={citation.marker}
              id={`citation-${String(citation.marker)}`}
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 2,
                flexWrap: 'wrap',
                fontSize: size,
                lineHeight: '18px',
              }}
            >
              <Typography
                variant="mono"
                component="span"
                sx={{ color: 'text.secondary', fontSize: size }}
              >
                {citation.marker}
              </Typography>
              <Icon size={14} aria-hidden="true" />
              {citation.url === null ? (
                <bdi>{title}</bdi>
              ) : (
                <Link href={citation.url} target="_blank" rel="noopener noreferrer">
                  <bdi>{title}</bdi>
                </Link>
              )}
              {citation.visibility === 'public' ? (
                <Box
                  component="span"
                  sx={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 1,
                    color: 'text.secondary',
                  }}
                >
                  <Globe size={14} aria-hidden="true" />
                  {t('tickets:assist.public')}
                </Box>
              ) : (
                <>
                  <Box
                    component="span"
                    sx={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 1,
                      height: 20,
                      paddingInline: '6px',
                      borderRadius: '6px',
                      backgroundColor: tokens['status.warning.tint'],
                      color: tokens['status.warning.text'],
                      fontSize: 12,
                      fontWeight: 500,
                    }}
                  >
                    <Lock size={14} aria-hidden="true" />
                    {t('tickets:assist.internal')}
                  </Box>
                  <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                    {t('tickets:assist.removedOnInsert')}
                  </Typography>
                </>
              )}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
