import type { RelatedTicket } from '@helpdock/schemas';
import { Box, Link as MuiLink, Typography } from '@mui/material';
import { Lock } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useT } from '../../app/i18n.js';
import { ticketRoute } from '../../app/route-paths.js';
import { useSemanticTokens } from '../../app/tokens.js';
import { StatusBadge } from './badges.tsx';
import { ticketReference } from './format.js';

/**
 * The details panel's Linked tickets, panel 6 of `Admin · view dialogs`
 * (M1-15 part 2): each linked ticket by reference, status, subject and how it
 * is joined to this one, as a card that opens it.
 *
 * A linked ticket the viewer cannot open is drawn as the locked line and
 * nothing else. The api sends it as its relation alone (`relatedTicketSchema`),
 * so there is no reference or subject here to leave out by mistake: whether it
 * sits in another department or was deleted is not something this screen could
 * say even if it tried (DOMAIN-RULES §1.2).
 */
export function LinkedTickets({
  related,
}: {
  readonly related: readonly RelatedTicket[];
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();

  const card = {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    paddingBlock: 2,
    paddingInline: 3,
    borderRadius: '8px',
    fontSize: 13,
  } as const;

  return (
    <Box component="section">
      <Typography variant="caption" component="h2" sx={{ color: 'text.secondary' }}>
        {t('tickets:details.linked')}
      </Typography>
      {related.length === 0 ? (
        <Typography variant="body2" sx={{ marginBlockStart: 2, color: 'text.secondary' }}>
          {t('tickets:details.noLinked')}
        </Typography>
      ) : (
        <Box
          component="ul"
          sx={{
            margin: 0,
            marginBlockStart: 2,
            padding: 0,
            listStyle: 'none',
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
          }}
        >
          {related.map((link, index) => {
            const relation = t(`tickets:details.relation.${link.relation}`);

            return (
              // A hidden link has no id; its place in the list is its identity.
              <Box component="li" key={link.visible ? `${link.relation}-${link.id}` : index}>
                {link.visible ? (
                  <MuiLink
                    component={Link}
                    to={ticketRoute(link.id)}
                    underline="none"
                    sx={{
                      ...card,
                      color: 'text.primary',
                      border: `1px solid ${tokens['border.default']}`,
                      '&:hover': { backgroundColor: tokens['bg.canvas'] },
                    }}
                  >
                    <Box component="span" sx={{ display: 'flex', gap: 2, alignItems: 'center' }}>
                      <Typography
                        component="bdi"
                        variant="mono"
                        sx={{ fontSize: 12, color: tokens['action.primary'] }}
                      >
                        {ticketReference(link)}
                      </Typography>
                      <StatusBadge status={link.status} />
                    </Box>
                    <Box component="span" sx={{ overflowWrap: 'anywhere' }}>
                      {link.subject}
                    </Box>
                    <Typography variant="caption" component="span" sx={{ color: 'text.secondary' }}>
                      {relation}
                    </Typography>
                  </MuiLink>
                ) : (
                  <Box
                    sx={{ ...card, backgroundColor: tokens['bg.canvas'], color: 'text.secondary' }}
                  >
                    <Box component="span" sx={{ display: 'flex', gap: 2, alignItems: 'center' }}>
                      <Lock size={14} aria-hidden="true" />
                      {t('tickets:details.linkedHidden')}
                    </Box>
                    <Typography variant="caption" component="span" sx={{ color: 'inherit' }}>
                      {t('tickets:details.linkedHiddenCaption', { relation })}
                    </Typography>
                  </Box>
                )}
              </Box>
            );
          })}
        </Box>
      )}
    </Box>
  );
}
