import type { CustomFieldPeople } from '@helpdock/schemas';
import { useQuery } from '@tanstack/react-query';
import { useOptionalBrandId, useTicketingApi } from '../auth/session.tsx';

/**
 * The staff a `person` custom field can name (M14-27), by public name, for the
 * signed-in brand. Read only by the controls that need it, so a brand with no
 * person field never asks. `GET /custom-fields/people` is `ticket:read`, which
 * every Agent holds, unlike the roster behind `staff:manage`.
 *
 * Somebody who left the brand is simply absent: callers draw a stored id that
 * is not in the list as a former staff member.
 */
export type CustomFieldPerson = CustomFieldPeople['people'][number];

export interface CustomFieldPeopleRead {
  readonly people: readonly CustomFieldPerson[];
  /** False until the list has arrived, so a stored id is not called "former staff" before it is known. */
  readonly loaded: boolean;
  /** The read failed: callers show a neutral fallback, never "former staff". */
  readonly failed: boolean;
}

export function useCustomFieldPeople(enabled = true): CustomFieldPeopleRead {
  const api = useTicketingApi();
  const brandId = useOptionalBrandId();
  const people = useQuery({
    queryKey: ['custom-field-people', brandId],
    queryFn: () => api.customFieldPeople(brandId ?? ''),
    staleTime: 60_000,
    retry: false,
    enabled: enabled && brandId !== null,
  });

  return { people: people.data?.people ?? [], loaded: people.isSuccess, failed: people.isError };
}
