import type { MetaTestResult, MetaTokenTestRequest } from '@helpdock/schemas';
import { useMutation } from '@tanstack/react-query';
import { CircleCheck } from 'lucide-react';
import { type ReactNode, useCallback, useState } from 'react';
import { useT } from '../../../../app/i18n.js';
import { usePreferences } from '../../../../app/providers.tsx';
import { currentBrand, useSession } from '../../../../auth/session.tsx';
import { isMetaError } from '../../../../meta/api.js';
import { useMetaApi } from '../../../../meta/context.tsx';
import { shortDate } from '../format.js';
import { MetaNote, NoteText } from './meta-note.tsx';

/**
 * What the Connect and Reconnect dialogs share about "Test": the mutation and
 * what it leaves behind ({@link useTokenTest}), a failed one as a sentence under
 * the field it concerns, and a passed one as a success box naming what Meta said
 * the token belongs to.
 */

type Translate = ReturnType<typeof useT>;

/** Where the sentence goes: under the id, under the token, or under the form. */
export interface TestProblem {
  readonly field: 'id' | 'token' | 'form';
  readonly message: string;
}

/** The refusals that are about the id the person typed rather than the token. */
const ABOUT_THE_ID = new Set(['account-taken']);
const ABOUT_THE_FORM = new Set(['app-not-configured', 'department-not-found', 'subscribe-failed']);

export const problemFromResult = (
  result: Extract<MetaTestResult, { ok: false }>,
  t: Translate,
): TestProblem => ({
  field: 'token',
  message:
    result.kind === 'connect'
      ? t('channels:meta.connect.unreachable')
      : result.detail === null
        ? t('channels:meta.connect.refusedBare')
        : t('channels:meta.connect.refused', { detail: result.detail }),
});

/** A refusal the api threw, in the catalog's words; anything else is "Meta could not be reached". */
export const problemFromError = (error: unknown, t: Translate): TestProblem => {
  if (!isMetaError(error)) {
    return { field: 'token', message: t('channels:meta.connect.unreachable') };
  }
  return {
    field: ABOUT_THE_ID.has(error.reason)
      ? 'id'
      : ABOUT_THE_FORM.has(error.reason)
        ? 'form'
        : 'token',
    message: t(`channels:meta.refusal.${error.reason}`),
  };
};

/**
 * "Test" of a dialog: the shape check first, which says what is wrong with the
 * id or the token without a round trip, then the api. What it found stays until
 * the person changes a field ({@link TokenTest.forget}), so Connect and
 * Reconnect, which stay off until a test has passed, always speak of the values
 * as typed. A refusal the api threw is {@link problemFromError}'s sentence;
 * `setProblem` is for the dialog's own save, which fails in the same words.
 */
export interface TokenTest {
  /** What Meta said of the token, once Test has run for the values as typed. */
  readonly tested: MetaTestResult | null;
  readonly problem: TestProblem | null;
  readonly setProblem: (problem: TestProblem | null) => void;
  readonly pending: boolean;
  readonly run: () => void;
  /** The values changed, or the dialog opened again: what was found no longer applies. */
  readonly forget: () => void;
}

export function useTokenTest({
  validate,
  request,
}: {
  /** The shape check: the sentence for a value that cannot be one, or null. */
  readonly validate: () => TestProblem | null;
  readonly request: () => MetaTokenTestRequest;
}): TokenTest {
  const t = useT();
  const api = useMetaApi();
  const brand = currentBrand(useSession());
  const [tested, setTested] = useState<MetaTestResult | null>(null);
  const [problem, setProblem] = useState<TestProblem | null>(null);
  const forget = useCallback((): void => {
    setTested(null);
    setProblem(null);
  }, []);

  const mutation = useMutation({
    mutationFn: async () => {
      const refusal = validate();
      if (refusal !== null) {
        setProblem(refusal);
        return null;
      }
      return api.testToken(brand.id, request());
    },
    onMutate: forget,
    onSuccess: (result) => {
      if (result === null) {
        return;
      }
      setTested(result);
      if (!result.ok) {
        setProblem(problemFromResult(result, t));
      }
    },
    onError: (error: unknown) => {
      setProblem(problemFromError(error, t));
    },
  });

  return {
    tested,
    problem,
    setProblem,
    pending: mutation.isPending,
    run: () => {
      mutation.mutate();
    },
    forget,
  };
}

/** "Token works · “Helpdock Support” · @helpdock · expires 9 Dec". */
export function TokenWorks({
  result,
}: {
  readonly result: Extract<MetaTestResult, { ok: true }>;
}): ReactNode {
  const t = useT();
  const { locale } = usePreferences();
  const expires =
    result.tokenExpiresAt === undefined
      ? null
      : t('channels:meta.connect.worksExpires', { date: shortDate(result.tokenExpiresAt, locale) });

  return (
    <MetaNote tone="success" role="status" icon={<CircleCheck size={16} aria-hidden="true" />}>
      <NoteText>
        {t('channels:meta.connect.works')} · <bdi>“{result.name}”</bdi>
        {result.username === undefined ? null : (
          <>
            {' · '}
            <bdi>@{result.username}</bdi>
          </>
        )}
        {expires === null ? null : ` · ${expires}`}
      </NoteText>
    </MetaNote>
  );
}
