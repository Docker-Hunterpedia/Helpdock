import type { useT } from '../../../../app/i18n.js';
import { isKnowledgeError } from '../../../../knowledge/api.js';

type T = ReturnType<typeof useT>;

/** The sentence for a refused knowledge action, or the one for "that did not work". */
export const knowledgeFailure = (t: T, error: unknown): string =>
  isKnowledgeError(error)
    ? t(`aiSettings:knowledge.refusals.${error.reason}`)
    : t('aiSettings:actionFailed');
