import type { ContactDetail } from '@helpdock/schemas';
import { Box } from '@mui/material';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { useT } from '../../app/i18n.js';
import { contactRoute, ROUTES } from '../../app/route-paths.js';
import { currentBrand, useContactsApi, useSession } from '../../auth/session.tsx';
import { PageHeader } from '../../shell/page-header.tsx';
import { ContactDialog } from './contact-dialogs.tsx';
import { useContactAction } from './use-contact-action.js';

/**
 * `/contacts/new`: the create form on a route of its own, so "add a contact" is
 * a link an agent can be sent, and cancelling goes back to the list rather than
 * leaving a dialog over a screen they did not choose.
 *
 * The form itself is the same dialog the edit action opens, because the fields
 * are the same fields and two copies of them would drift.
 */
export function NewContactPage(): ReactNode {
  const t = useT();
  const session = useSession();
  const api = useContactsApi();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const brand = currentBrand(session);

  const accounts = useQuery({
    queryKey: ['accounts', brand.id, ''],
    queryFn: () => api.listAccounts(brand.id),
  });

  const create = useContactAction(
    (value: Parameters<typeof api.createContact>[1]) => api.createContact(brand.id, value),
    (_value, result: ContactDetail) => t('contacts:toast.created', { name: result.name }),
    async (result: ContactDetail) => {
      await queryClient.invalidateQueries({ queryKey: ['contacts', brand.id] });
      await navigate(contactRoute(result.id));
    },
  );

  return (
    <Box>
      <PageHeader title={t('contacts:dialog.createTitle')} />
      <ContactDialog
        open
        contact={null}
        accounts={accounts.data?.accounts ?? []}
        busy={create.isPending}
        onClose={() => {
          void navigate(ROUTES.contacts);
        }}
        onSubmit={(value) => {
          create.mutate({
            name: value.name,
            accountId: value.accountId,
            locale: value.locale,
            timezone: value.timezone,
            externalId: value.externalId,
            identities: value.identity === null ? [] : [value.identity],
          });
        }}
      />
    </Box>
  );
}
