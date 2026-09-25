import type {
  ContactSummary,
  Department,
  StaffMember,
  TagSummary,
  TicketStatus,
} from '@helpdock/schemas';
import { useQuery } from '@tanstack/react-query';
import {
  useContactsApi,
  useStaffApi,
  useTicketingApi,
  useTicketsApi,
} from '../../auth/session.tsx';
import { ticketKeys } from '../../tickets/keys.js';

/**
 * The reads every part of the workspace shares: the brand's statuses, its
 * departments and its staff.
 *
 * Contacts are not among them. A list row's contact name arrives embedded in
 * the ticket (M1-15), and the open ticket reads its one contact in full; the
 * first page of the contact list this hook used to read named only the rows
 * whose contact happened to be on it.
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
  /** M1-05: what a tag filter and a view's summary are named from. */
  readonly tags: readonly TagSummary[];
}

/**
 * The brand's departments, on the key the Departments tab shares. `enabled`
 * lets the sidebar, which is on every screen, read them only when a dialog
 * needs them.
 */
export function useDepartments(brandId: string, enabled = true): readonly Department[] {
  const staffApi = useStaffApi();
  const departments = useQuery({
    queryKey: ['departments', brandId],
    queryFn: () => staffApi.departments(brandId),
    staleTime: DIRECTORY_STALE_MS,
    enabled,
  });

  return departments.data?.departments ?? [];
}

export function useWorkspaceData(brandId: string): WorkspaceData {
  const tickets = useTicketsApi();
  const staffApi = useStaffApi();
  const ticketingApi = useTicketingApi();

  const statuses = useQuery({
    queryKey: ticketKeys.statuses(brandId),
    queryFn: () => tickets.statuses(brandId),
    staleTime: DIRECTORY_STALE_MS,
  });

  const departments = useDepartments(brandId);

  /**
   * `GET /staff` declares `staff:manage`, which an Agent does not hold, so this
   * read is allowed to fail: `directory.ts` names who it can and shortens the
   * rest. The assignee picker does not depend on it; it reads M1-07's
   * `assignable`, which `ticket:write` reaches (`ticket-view.tsx`).
   */
  const staff = useQuery({
    queryKey: ['staff', brandId, ''],
    queryFn: () => staffApi.listStaff(brandId),
    staleTime: DIRECTORY_STALE_MS,
    retry: false,
  });

  // The Tags tab's own key, so the two share one cache and an edit there is
  // what the filter popover shows next.
  const tags = useQuery({
    queryKey: ['tags', brandId],
    queryFn: () => ticketingApi.tags(brandId),
    staleTime: DIRECTORY_STALE_MS,
  });

  return {
    statuses: statuses.data?.statuses ?? [],
    departments,
    staff: staff.data?.staff ?? [],
    tags: tags.data?.tags ?? [],
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
