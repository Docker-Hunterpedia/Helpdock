import {
  KNOWLEDGE_CRAWL_MAX_PAGES,
  KNOWLEDGE_FILE_MIME_TYPES,
  KNOWLEDGE_UPLOAD_MAX_BYTES,
  type KnowledgeSourceCreate,
  type KnowledgeVisibility,
} from '@helpdock/schemas';

/** The add-source dialog's state, one shape for every kind (`Admin/AI-Knowledge`). */
export type AddKind = 'file' | 'crawl' | 'notion' | 'gdrive';
export type ChosenSchedule = 'daily' | 'weekly' | 'manual';

export interface AddSourceDraft {
  readonly kind: AddKind;
  readonly visibility: KnowledgeVisibility;
  readonly schedule: ChosenSchedule;
  readonly files: readonly File[];
  readonly mode: 'sitemap' | 'seed';
  readonly url: string;
  readonly maxPages: string;
  readonly include: string;
  readonly exclude: string;
  readonly render: boolean;
  readonly name: string;
  readonly token: string;
}

export const EMPTY_DRAFT: AddSourceDraft = {
  kind: 'crawl',
  visibility: 'internal',
  schedule: 'daily',
  files: [],
  mode: 'sitemap',
  url: '',
  maxPages: '600',
  include: '',
  exclude: '',
  render: false,
  name: '',
  token: '',
};

export type AddProblem =
  | { readonly field: 'files'; readonly key: 'filesRequired' }
  | { readonly field: 'files'; readonly key: 'fileTooBig' | 'fileType'; readonly name: string }
  | { readonly field: 'url'; readonly key: 'urlInvalid' }
  | { readonly field: 'maxPages'; readonly key: 'maxPagesInvalid' }
  | { readonly field: 'name'; readonly key: 'nameRequired' };

const lines = (text: string): string[] =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');

const isHttpUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
};

/** Why the chosen files cannot be uploaded, or null. */
export const fileProblem = (files: readonly File[]): AddProblem | null => {
  if (files.length === 0) {
    return { field: 'files', key: 'filesRequired' };
  }
  for (const file of files) {
    if (!KNOWLEDGE_FILE_MIME_TYPES.some((type) => type === file.type)) {
      return { field: 'files', key: 'fileType', name: file.name };
    }
    if (file.size > KNOWLEDGE_UPLOAD_MAX_BYTES) {
      return { field: 'files', key: 'fileTooBig', name: file.name };
    }
  }
  return null;
};

/** The create request a crawl, Notion or Drive draft makes, or what stops it. */
export const createRequestOf = (
  draft: AddSourceDraft,
):
  | { readonly ok: true; readonly request: KnowledgeSourceCreate }
  | { readonly ok: false; readonly problems: readonly AddProblem[] } => {
  const { visibility, schedule } = draft;
  if (draft.kind === 'crawl') {
    const problems: AddProblem[] = [];
    const maxPages = Number(draft.maxPages);
    if (!isHttpUrl(draft.url.trim())) {
      problems.push({ field: 'url', key: 'urlInvalid' });
    }
    if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > KNOWLEDGE_CRAWL_MAX_PAGES) {
      problems.push({ field: 'maxPages', key: 'maxPagesInvalid' });
    }
    return problems.length > 0
      ? { ok: false, problems }
      : {
          ok: true,
          request: {
            kind: 'crawl',
            visibility,
            schedule,
            config: {
              mode: draft.mode,
              url: draft.url.trim(),
              maxPages,
              include: lines(draft.include),
              exclude: lines(draft.exclude),
              render: draft.render,
            },
          },
        };
  }
  const name = draft.name.trim();
  if (name === '') {
    return { ok: false, problems: [{ field: 'name', key: 'nameRequired' }] };
  }
  if (draft.kind === 'notion') {
    const token = draft.token.trim();
    return {
      ok: true,
      request: { kind: 'notion', name, visibility, schedule, ...(token === '' ? {} : { token }) },
    };
  }
  return { ok: true, request: { kind: 'gdrive', name, visibility, schedule } };
};
