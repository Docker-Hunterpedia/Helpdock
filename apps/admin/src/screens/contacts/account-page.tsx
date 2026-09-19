import type { Account } from '@helpdock/schemas';
import {
  Box,
  Button,
  Link as MuiLink,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Users } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useT } from '../../app/i18n.js';
import { contactRoute, ROUTES } from '../../app/route-paths.js';
import { useSemanticTokens } from '../../app/tokens.js';
import { currentBrand, useContactsApi, useSession } from '../../auth/session.tsx';
import { EmptyState } from '../../shell/empty-state.tsx';
import { PageHeader } from '../../shell/page-header.tsx';
import { AccountDialog } from './contact-dialogs.tsx';
import { DASH } from './format.js';
import { ContactAvatar } from './identity-pieces.tsx';
import { useContactAction } from './use-contact-action.js';

/**
 * One customer company and the people filed under it. Minimal on purpose: a
 * name, a domain and a list, because that is what an account *is* until M1-06
 * gives it custom fields.
 */
export function AccountPage(): ReactNode {
  const t = useT();
  const session = useSession();
  const api = useContactsApi();
  const tokens = useSemanticTokens();
  const queryClient = useQueryClient();
  const { accountId = '' } = useParams();

  const brand = currentBrand(session);
  const [editing, setEditing] = useState(false);

  const account = useQuery({
    queryKey: ['account', brand.id, accountId],
    queryFn: () => api.account(brand.id, accountId),
  });

  const save = useContactAction(
    (value: { name: string; domain: string | null }) =>
      api.updateAccount(brand.id, accountId, value),
    (_value, result: Account) => t('contacts:toast.accountUpdated', { name: result.name }),
    async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['account', brand.id, accountId] }),
        queryClient.invalidateQueries({ queryKey: ['accounts', brand.id] }),
      ]);
    },
  );

  const detail = account.data;
  if (detail === undefined) {
    return null;
  }

  return (
    <>
      <Typography variant="caption" sx={{ color: 'text.secondary' }}>
        <MuiLink component={Link} to={`${ROUTES.contacts}?tab=accounts`}>
          {t('contacts:accounts.breadcrumb')}
        </MuiLink>
        {' / '}
      </Typography>

      <PageHeader
        title={detail.account.name}
        caption={detail.account.domain ?? t('contacts:accounts.noDomain')}
        action={
          <Button
            variant="outlined"
            onClick={() => {
              setEditing(true);
            }}
          >
            {t('contacts:detail.edit')}
          </Button>
        }
      />

      {detail.contacts.length === 0 ? (
        <EmptyState
          icon={Users}
          heading={t('contacts:empty.accountContactsHeading')}
          body={t('contacts:empty.accountContactsBody')}
        />
      ) : (
        <TableContainer
          sx={{
            borderRadius: '10px',
            border: `1px solid ${tokens['border.default']}`,
            backgroundColor: tokens['bg.surface'],
          }}
        >
          <Table aria-label={t('contacts:accounts.contacts')}>
            <TableHead>
              <TableRow sx={{ backgroundColor: tokens['bg.muted'] }}>
                <TableCell>{t('contacts:table.contact')}</TableCell>
                <TableCell>{t('contacts:table.channels')}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {detail.contacts.map((contact) => (
                <TableRow key={contact.id} sx={{ height: 44 }}>
                  <TableCell>
                    <Box sx={{ display: 'flex', gap: 3, alignItems: 'center' }}>
                      <ContactAvatar name={contact.name} />
                      <MuiLink component={Link} to={contactRoute(contact.id)} variant="bodyStrong">
                        {contact.name}
                      </MuiLink>
                    </Box>
                  </TableCell>
                  <TableCell>
                    <bdi>{contact.primaryIdentity?.value ?? DASH}</bdi>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      <AccountDialog
        open={editing}
        account={detail.account}
        busy={save.isPending}
        onClose={() => {
          setEditing(false);
        }}
        onSubmit={(value) => {
          setEditing(false);
          save.mutate(value);
        }}
      />
    </>
  );
}
