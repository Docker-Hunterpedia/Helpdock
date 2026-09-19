import type { Account, ContactSummary } from '@helpdock/schemas';
import {
  Box,
  Link as MuiLink,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useT } from '../../app/i18n.js';
import { accountRoute, contactRoute } from '../../app/route-paths.js';
import { useSemanticTokens } from '../../app/tokens.js';
import { csatLabel, DASH, isAnonymousVisitor } from './format.js';
import { ChannelIcons, ContactAvatar, IdentityLine } from './identity-pieces.tsx';

/**
 * The two tables the contact list draws, one per tab. They are here rather than
 * inside the screen because they share nothing but the card they sit in: one is
 * about people and the other about companies, and a screen that renders both
 * inline reads as one function doing two jobs.
 *
 * DESIGN §6.5 Tables: 44 px rows, header on `bg.muted`, mono for numbers,
 * numerals end-aligned and text start-aligned.
 */

const CARD = (border: string, surface: string) => ({
  borderRadius: '10px',
  border: `1px solid ${border}`,
  backgroundColor: surface,
});

export function ContactsTable({
  contacts,
  brandName,
  footer,
  empty,
}: {
  readonly contacts: readonly ContactSummary[];
  readonly brandName: string;
  /** The pagination bar, which belongs to the screen that owns the cursor. */
  readonly footer: ReactNode;
  /** Drawn under the header when there are no rows. */
  readonly empty: ReactNode;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();

  return (
    <TableContainer sx={CARD(tokens['border.default'], tokens['bg.surface'])}>
      <Table aria-label={t('contacts:table.caption', { brand: brandName })}>
        <TableHead>
          <TableRow sx={{ backgroundColor: tokens['bg.muted'] }}>
            <TableCell>{t('contacts:table.contact')}</TableCell>
            <TableCell>{t('contacts:table.account')}</TableCell>
            <TableCell>{t('contacts:table.channels')}</TableCell>
            <TableCell align="right">{t('contacts:table.open')}</TableCell>
            <TableCell>{t('contacts:table.csat')}</TableCell>
            <TableCell>{t('contacts:table.lastTicket')}</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {contacts.map((contact) => (
            <TableRow key={contact.id} sx={{ height: 44 }}>
              <TableCell>
                <ContactCell contact={contact} />
              </TableCell>
              <TableCell>
                {contact.account === null ? (
                  DASH
                ) : (
                  <MuiLink component={Link} to={accountRoute(contact.account.id)}>
                    {contact.account.name}
                  </MuiLink>
                )}
              </TableCell>
              <TableCell>
                <ChannelIcons channels={contact.channels} />
              </TableCell>
              <TableCell align="right">
                <Typography
                  variant="mono"
                  sx={{
                    color:
                      contact.stats.openTickets > 0
                        ? tokens['status.danger.text']
                        : 'text.secondary',
                  }}
                >
                  {contact.stats.openTickets}
                </Typography>
              </TableCell>
              <TableCell>{csatLabel(contact.stats.csat)}</TableCell>
              <TableCell>
                {contact.stats.lastTicketAt === null
                  ? DASH
                  : new Date(contact.stats.lastTicketAt).toLocaleDateString()}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {empty}
      {footer}
    </TableContainer>
  );
}

/** Avatar, name, the identifier the row is headed by, and the anonymous mark. */
function ContactCell({ contact }: { readonly contact: ContactSummary }): ReactNode {
  const t = useT();
  const anonymous = isAnonymousVisitor(contact);

  return (
    <Box sx={{ display: 'flex', gap: 3, alignItems: 'center' }}>
      <ContactAvatar name={contact.name} anonymous={anonymous} />
      <Box>
        <MuiLink
          component={Link}
          to={contactRoute(contact.id)}
          variant="bodyStrong"
          sx={{ display: 'block' }}
        >
          {contact.name}
        </MuiLink>
        {contact.primaryIdentity === null ? (
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            {t('contacts:identity.none')}
          </Typography>
        ) : (
          <IdentityLine identity={contact.primaryIdentity} component="div" />
        )}
        {anonymous ? (
          <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary' }}>
            {t('contacts:anonymous.badge')}
          </Typography>
        ) : null}
      </Box>
    </Box>
  );
}

export function AccountsTable({ accounts }: { readonly accounts: readonly Account[] }): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();

  return (
    <TableContainer sx={CARD(tokens['border.default'], tokens['bg.surface'])}>
      <Table aria-label={t('contacts:accounts.title')}>
        <TableHead>
          <TableRow sx={{ backgroundColor: tokens['bg.muted'] }}>
            <TableCell>{t('contacts:table.accountName')}</TableCell>
            <TableCell>{t('contacts:table.domain')}</TableCell>
            <TableCell align="right">{t('contacts:table.people')}</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {accounts.map((account) => (
            <TableRow key={account.id} sx={{ height: 44 }}>
              <TableCell>
                <MuiLink component={Link} to={accountRoute(account.id)} variant="bodyStrong">
                  {account.name}
                </MuiLink>
              </TableCell>
              <TableCell>
                <bdi>{account.domain ?? DASH}</bdi>
              </TableCell>
              <TableCell align="right">
                <Typography variant="mono">{account.contactCount}</Typography>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}
