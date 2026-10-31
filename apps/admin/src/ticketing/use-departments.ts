import type { DepartmentSummaryList } from '@helpdock/schemas';
import { type UseQueryResult, useQuery } from '@tanstack/react-query';
import { useTicketingApi } from '../auth/session.tsx';

/**
 * The one cache entry for a brand's departments.
 *
 * Every screen that reads departments goes through {@link useDepartmentsQuery},
 * so the key has exactly one loader and one schema (the superset
 * `departmentSummaryListSchema`). React Query keeps one entry per key and
 * refetches it with whichever observer's `queryFn` runs; two loaders under one
 * key would hand a screen data parsed by the other one's schema, and in the
 * mock adapter would read two stores, so a refetch could undo a reorder.
 */
export const departmentsKey = (brandId: string) => ['departments', brandId] as const;

export interface DepartmentsQueryOptions {
  readonly enabled?: boolean;
  readonly staleTime?: number;
  readonly retry?: boolean;
}

export function useDepartmentsQuery(
  brandId: string,
  options: DepartmentsQueryOptions = {},
): UseQueryResult<DepartmentSummaryList> {
  const ticketing = useTicketingApi();

  return useQuery({
    queryKey: departmentsKey(brandId),
    queryFn: () => ticketing.departments(brandId),
    ...options,
  });
}
