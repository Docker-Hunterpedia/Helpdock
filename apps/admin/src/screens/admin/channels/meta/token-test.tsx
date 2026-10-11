import type { MetaTestResult } from '@helpdock/schemas';
import { Box } from '@mui/material';
import { CircleCheck } from 'lucide-react';
import type { ReactNode } from 'react';
import { useT } from '../../../../app/i18n.js';
import { usePreferences } from '../../../../app/providers.tsx';
import { useSemanticTokens } from '../../../../app/tokens.js';
import { isMetaError } from '../../../../meta/api.js';
import { shortDate } from '../format.js';

/**
 * What the Connect and Reconnect dialogs share about "Test": a failed one is a
 * sentence under the field it concerns, and a passed one is a success box
 * naming what Meta said the token belongs to.
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

/** "Token works · “Helpdock Support” · @helpdock · expires 9 Dec". */
export function TokenWorks({
  result,
}: {
  readonly result: Extract<MetaTestResult, { ok: true }>;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const { locale } = usePreferences();
  const expires =
    result.tokenExpiresAt === undefined
      ? null
      : t('channels:meta.connect.worksExpires', { date: shortDate(result.tokenExpiresAt, locale) });

  return (
    <Box
      role="status"
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        paddingBlock: 2,
        paddingInline: 3,
        borderRadius: '6px',
        border: `1px solid ${tokens['status.success']}`,
        backgroundColor: tokens['status.success.tint'],
        color: tokens['status.success.text'],
        fontSize: 13,
      }}
    >
      <CircleCheck size={16} aria-hidden="true" style={{ flexShrink: 0 }} />
      <span>
        {t('channels:meta.connect.works')} · <bdi>“{result.name}”</bdi>
        {result.username === undefined ? null : (
          <>
            {' · '}
            <bdi>@{result.username}</bdi>
          </>
        )}
        {expires === null ? null : ` · ${expires}`}
      </span>
    </Box>
  );
}
