import type { Session, SessionBrand } from '@helpdock/schemas';
import { type UseQueryResult, useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, type ReactNode, useCallback, useContext } from 'react';
import type { ContactsApi } from '../contacts/api.js';
import type { StaffApi } from '../staff/api.js';
import type { AuthApi } from './api.js';

/** One cache entry holds the session; every screen reads it from there. */
const SESSION_QUERY_KEY = ['auth', 'session'] as const;

const AuthApiContext = createContext<AuthApi | null>(null);
const StaffApiContext = createContext<StaffApi | null>(null);
const ContactsApiContext = createContext<ContactsApi | null>(null);
const SessionContext = createContext<Session | null>(null);

export function AuthApiProvider({
  api,
  staffApi,
  contactsApi,
  children,
}: {
  readonly api: AuthApi;
  /** Optional so a test that only exercises auth can leave it out. */
  readonly staffApi?: StaffApi | undefined;
  readonly contactsApi?: ContactsApi | undefined;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <AuthApiContext.Provider value={api}>
      <StaffApiContext.Provider value={staffApi ?? null}>
        <ContactsApiContext.Provider value={contactsApi ?? null}>
          {children}
        </ContactsApiContext.Provider>
      </StaffApiContext.Provider>
    </AuthApiContext.Provider>
  );
}

export function useAuthApi(): AuthApi {
  const api = useContext(AuthApiContext);
  if (!api) {
    throw new Error('useAuthApi needs an <AuthApiProvider> above it');
  }

  return api;
}

export function useStaffApi(): StaffApi {
  const api = useContext(StaffApiContext);
  if (!api) {
    throw new Error('useStaffApi needs an <AuthApiProvider> with a staffApi above it');
  }

  return api;
}

export function useContactsApi(): ContactsApi {
  const api = useContext(ContactsApiContext);
  if (!api) {
    throw new Error('useContactsApi needs an <AuthApiProvider> with a contactsApi above it');
  }

  return api;
}

/**
 * The session as the app knows it: whatever the last sign-in put in the cache,
 * refreshed once on load from `me()`. It is deliberately not persisted — the
 * real session is a cookie the api owns from M0-05 on.
 */
export function useSessionQuery(): UseQueryResult<Session | null> {
  const api = useAuthApi();

  return useQuery({
    queryKey: SESSION_QUERY_KEY,
    queryFn: () => api.me(),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
}

export function useSetSession(): (session: Session | null) => void {
  const queryClient = useQueryClient();

  return useCallback(
    (session: Session | null) => {
      queryClient.setQueryData(SESSION_QUERY_KEY, session);
    },
    [queryClient],
  );
}

export function SessionProvider({
  session,
  children,
}: {
  readonly session: Session;
  readonly children: ReactNode;
}): ReactNode {
  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}

/** Only valid below `RequireSession`, which is what guarantees a session. */
export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) {
    throw new Error('useSession needs a <SessionProvider> above it');
  }

  return session;
}

export function currentBrand(session: Session): SessionBrand {
  const brand =
    session.brands.find((candidate) => candidate.id === session.currentBrandId) ??
    session.brands[0];

  if (!brand) {
    throw new Error('a session always carries at least one brand');
  }

  return brand;
}

/**
 * Switching brand rewrites the cached session. It stays client-side on purpose:
 * the brand a request runs in is a header the api reads (ARCHITECTURE §6), so
 * there is nothing to post until M0-04 lands the tenancy plumbing.
 */
export function useSwitchBrand(): (brandId: string) => void {
  const queryClient = useQueryClient();

  return useCallback(
    (brandId: string) => {
      queryClient.setQueryData(SESSION_QUERY_KEY, (session: Session | null | undefined) =>
        session ? { ...session, currentBrandId: brandId } : session,
      );
    },
    [queryClient],
  );
}
