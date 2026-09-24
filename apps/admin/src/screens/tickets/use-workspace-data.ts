import type { ContactSummary, Department, StaffMember, TicketStatus } from '@helpdock/schemas';
import { useQuery } from '@tanstack/react-query';
import { useContactsApi, useStaffApi, useTicketsApi } from '../../auth/session.tsx';
import { ticketKeys } from '../../tickets/keys.js';
import { contactAddressesOf, contactNamesOf } from './directory.js';

/**
 * The reads every part of the workspace shares: the brand's statuses, its
 * departments, its staff and enough of its contacts to put names on rows.
 *
 * They are one hook because they are one cache: the list, the thread, the
 * details panel, the filter popover and the new-ticket dialog all name the same
 * people, and four components each reading them would be four requests for the
 * same answer.
 *
 * Nothing here retries. A read that fails leaves the screen with a name it
 * cannot resolve, which the directory draws as a shortened id; a retry storm
 * behind a picker would be worse than a missing label.
 */

const DIRECTORY_STALE_MS = 60_000;

export interface WorkspaceData {
  readonly statuses: readonly TicketStatus[];
  readonly departments: readonly Department[];
  readonly staff: readonly StaffMember[];
  readonly contacts: readonly ContactSummary[];
  readonly contactNames: ReadonlyMap<string, string>;
  readonly contactAddresses: ReadonlyMap<string, string>;
}

export function useWorkspaceData(brandId: string): WorkspaceData {
  const tickets = useTicketsApi();
  const staffApi = useStaffApi();
  const contactsApi = useContactsApi();

  const statuses = useQuery({
    queryKey: ticketKeys.statuses(brandId),
    queryFn: () => tickets.statuses(brandId),
    staleTime: DIRECTORY_STALE_MS,
  });

  const departments = useQuery({
    queryKey: ['departments', brandId],
    queryFn: () => staffApi.departments(brandId),
    staleTime: DIRECTORY_STALE_MS,
  });

  /**
   * `GET /staff` declares `staff:manage`, which an Agent does not hold, so this
   * read is allowed to fail: `directory.ts` names who it can and shortens the
   * rest. M1-07 is where a read of assignable agents belongs.
   */
  const staff = useQuery({
    queryKey: ['staff', brandId, ''],
    queryFn: () => staffApi.listStaff(brandId),
    staleTime: DIRECTORY_STALE_MS,
    retry: false,
  });

  const contacts = useQuery({
    queryKey: ['contacts', brandId, {}],
    queryFn: () => contactsApi.listContacts(brandId),
    staleTime: DIRECTORY_STALE_MS,
  });

  const rows = contacts.data?.contacts ?? [];

  return {
    statuses: statuses.data?.statuses ?? [],
    departments: departments.data?.departments ?? [],
    staff: staff.data?.staff ?? [],
    contacts: rows,
    contactNames: contactNamesOf(rows),
    contactAddresses: contactAddressesOf(rows),
  };
}

/** The contacts matching what somebody typed into the new-ticket dialog. */
export function useContactSearch(brandId: string, term: string): readonly ContactSummary[] {
  const contactsApi = useContactsApi();
  const trimmed = term.trim();

  const results = useQuery({
    queryKey: ['contacts', brandId, { search: trimmed }],
    queryFn: () => contactsApi.listContacts(brandId, trimmed === '' ? {} : { search: trimmed }),
    staleTime: DIRECTORY_STALE_MS,
  });

  return results.data?.contacts ?? [];
}
