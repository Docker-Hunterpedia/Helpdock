import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { SyntaxKind, type Token, tokenize } from './controller-scan.ts';

const ALLOWED_MODULES = new Set([
  '../../sla/ticket-clocks.js',
  '../../sla/sla.repository.js',
  '../../sla/policy-match.js',
  '../../sla/clock.js',
  '../../sla/calendars.js',
  '../preflight/staged-record.js',
  '../article-asset-proof.js',
  '../article-asset-requests.js',
  '../article-asset-state.js',
  '../article-prepared.js',
  '../../help-center/help-center.repository.js',
  '../../help-center/slugs.js',
  '../../media/keys.js',
  '../../media/object-purge.js',
  '@helpdock/channels',
  '@helpdock/db',
  '@helpdock/importers',
  '@helpdock/schemas',
  'drizzle-orm',
  'zod',
  'node:crypto',
]);
const PURE_CHANNEL_EXPORTS = new Set([
  'sanitizeMessageBody',
  'sanitizeMessageHtml',
  'sanitizeArticleHtml',
  'articleImageSources',
  'articleLinkTargets',
  'htmlToText',
]);
const REVIEWED_EXPORTS = new Map([
  ['../../sla/ticket-clocks.js', new Set(['isResponseClock', 'reconcileClocks', 'summaryColumns'])],
  ['../../sla/sla.repository.js', new Set(['SlaRepository'])],
  ['../../sla/policy-match.js', new Set(['matchPolicy'])],
  ['../../sla/clock.js', new Set(['Clock', 'satisfy'])],
  ['../../sla/calendars.js', new Set(['buildCalendars'])],
  ['../preflight/staged-record.js', new Set(['validatedStagedRecord'])],
  [
    '../article-asset-proof.js',
    new Set(['ArticleAssetProof', 'readArticleAssetProof', 'requireReadyArticleAsset']),
  ],
  [
    '../article-asset-requests.js',
    new Set(['articleCopyAssetRequests', 'importArticleAssetRequests']),
  ],
  ['../article-asset-state.js', new Set(['importArticlePreparationSchema'])],
  ['../article-prepared.js', new Set(['preparedImportArticleHash'])],
  ['@helpdock/channels', PURE_CHANNEL_EXPORTS],
  ['@helpdock/importers', new Set(['hashImportValue'])],
  ['../../help-center/help-center.repository.js', new Set(['HelpCenterRepository'])],
  ['../../help-center/slugs.js', new Set(['resolveSlug'])],
  ['../../media/keys.js', new Set(['attachmentKey'])],
  ['../../media/object-purge.js', new Set(['enqueueObjectPurge'])],
]);
const FORBIDDEN_IDENTIFIERS = new Set([
  'TicketsService',
  'TicketLifecycleHooks',
  'ReplyDeliveryHook',
  'requestAutoAssign',
  'enqueueContactCreated',
  'enqueueOutbox',
  'outbox',
  'nextMessageSeq',
  'fetch',
  'eval',
  'Function',
]);

function dependencyViolations(tokens: readonly Token[], index: number): string[] {
  const declaration: Token[] = [];
  for (const token of tokens.slice(index + 1)) {
    declaration.push(token);
    if (token.kind === SyntaxKind.StringLiteral || token.kind === SyntaxKind.SemicolonToken) break;
  }
  const specifier = declaration
    .find((token) => token.kind === SyntaxKind.StringLiteral)
    ?.text.slice(1, -1);
  if (specifier === undefined) return [];
  const failures: string[] = [];
  if (
    specifier.includes('\\') ||
    (!ALLOWED_MODULES.has(specifier) &&
      !(specifier.startsWith('./') && !specifier.split('/').includes('..')))
  )
    failures.push(`unreviewed dependency: ${specifier}`);
  const allowedExports = REVIEWED_EXPORTS.get(specifier);
  if (!allowedExports) return failures;
  if (
    declaration.some((token) => token.kind === SyntaxKind.AsteriskToken) ||
    declaration[0]?.kind !== SyntaxKind.OpenBraceToken
  )
    return [...failures, `namespace/default imports are forbidden: ${specifier}`];
  for (let position = 1; position < declaration.length; position += 1) {
    const token = declaration[position];
    if (token?.kind === SyntaxKind.CloseBraceToken) break;
    if (
      token?.kind === SyntaxKind.Identifier &&
      declaration[position - 1]?.kind !== SyntaxKind.AsKeyword &&
      !allowedExports.has(token.text)
    )
      failures.push(`unreviewed export: ${specifier}:${token.text}`);
  }
  return failures;
}

/** Uses the repository's TypeScript 7 scanner; comments and body strings are not executable identifiers. */
export function findImportWriterViolations(source: string): string[] {
  const violations = new Set<string>();
  const tokens = tokenize(source, 'writer.ts');
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    if (
      token.kind === SyntaxKind.Identifier &&
      (FORBIDDEN_IDENTIFIERS.has(token.text) || token.text === 'require')
    )
      violations.add(`forbidden symbol: ${token.text}`);
    if (
      token.kind === SyntaxKind.ImportKeyword &&
      tokens[index + 1]?.kind === SyntaxKind.OpenParenToken
    )
      violations.add('dynamic module loading is forbidden');
    else if (
      token.kind === SyntaxKind.ImportKeyword ||
      (token.kind === SyntaxKind.ExportKeyword &&
        [SyntaxKind.OpenBraceToken, SyntaxKind.AsteriskToken].includes(
          tokens[index + 1]?.kind ?? SyntaxKind.Unknown,
        ))
    )
      for (const violation of dependencyViolations(tokens, index)) violations.add(violation);
  }
  return [...violations];
}

/** Extraction/finish may use the outbox; no import layer may invoke live ticket hooks or direct fetch. */
export function findImportLifecycleViolations(source: string): string[] {
  const violations = new Set<string>();
  const tokens = tokenize(source, 'import.ts');
  const allowedEvents = new Set([
    'import.work_requested',
    'import.file_uploaded',
    'attachment.uploaded',
    'media.objects.purge',
    'help_center.media_uploaded',
    'help_center.imported',
    'import.sla_activation_requested',
  ]);
  const allowedConstants = new Set<string>();
  for (let index = 0; index < tokens.length; index++) {
    if (
      tokens[index]?.kind === SyntaxKind.ConstKeyword &&
      tokens[index + 1]?.kind === SyntaxKind.Identifier &&
      tokens[index + 2]?.kind === SyntaxKind.EqualsToken
    ) {
      const value = tokens[index + 3];
      if (value?.kind === SyntaxKind.StringLiteral && allowedEvents.has(value.text.slice(1, -1)))
        allowedConstants.add(tokens[index + 1]?.text ?? '');
    }
    if (tokens[index]?.kind !== SyntaxKind.ImportKeyword) continue;
    const declaration: Token[] = [];
    for (const token of tokens.slice(index + 1)) {
      declaration.push(token);
      if (token.kind === SyntaxKind.StringLiteral || token.kind === SyntaxKind.SemicolonToken)
        break;
    }
    const specifier = declaration
      .find((token) => token.kind === SyntaxKind.StringLiteral)
      ?.text.slice(1, -1);
    const reviewed =
      specifier === '@helpdock/schemas'
        ? new Set(['HC_IMPORTED_EVENT', 'HC_MEDIA_UPLOADED_EVENT'])
        : specifier?.endsWith('/media/object-purge.js')
          ? new Set(['OBJECT_PURGE_EVENT'])
          : new Set<string>();
    for (let at = 0; at < declaration.length; at++) {
      const name = declaration[at]?.text;
      if (name && reviewed.has(name))
        allowedConstants.add(
          declaration[at + 1]?.kind === SyntaxKind.AsKeyword
            ? (declaration[at + 2]?.text ?? '')
            : name,
        );
    }
  }
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (
      token &&
      [
        SyntaxKind.StringLiteral,
        SyntaxKind.NoSubstitutionTemplateLiteral,
        SyntaxKind.TemplateHead,
      ].includes(token.kind) &&
      /\binsert\s+into\s+(?:"?public"?\.)?"?outbox"?\b/i.test(token.text)
    )
      violations.add('raw SQL import outbox writes are forbidden');
    if (token?.text !== 'enqueueOutbox') continue;
    if (tokens[index + 1]?.kind === SyntaxKind.AsKeyword)
      violations.add('outbox producer aliases are forbidden');
    if (tokens[index + 1]?.kind !== SyntaxKind.OpenParenToken) continue;
    if (tokens[index + 4]?.kind !== SyntaxKind.OpenBraceToken) {
      violations.add('outbox payload must declare its allowed event inline');
      continue;
    }
    let depth = 1,
      found = false;
    for (let at = index + 5; at < tokens.length && depth > 0; at++) {
      const part = tokens[at];
      if (part?.kind === SyntaxKind.OpenBraceToken) depth++;
      if (part?.kind === SyntaxKind.CloseBraceToken) depth--;
      if (depth === 1 && part?.kind === SyntaxKind.DotDotDotToken)
        violations.add('import outbox payload spreads are forbidden');
      if (depth !== 1 || part?.text !== 'event' || tokens[at + 1]?.kind !== SyntaxKind.ColonToken)
        continue;
      found = true;
      const value = tokens[at + 2];
      if (
        !value ||
        !(value.kind === SyntaxKind.StringLiteral
          ? allowedEvents.has(value.text.slice(1, -1))
          : value.kind === SyntaxKind.Identifier && allowedConstants.has(value.text))
      )
        violations.add('unreviewed import outbox event');
    }
    if (!found) violations.add('import outbox event must be explicit');
  }
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (!token) continue;
    if (
      token.kind === SyntaxKind.ImportKeyword &&
      tokens[index + 1]?.kind === SyntaxKind.OpenParenToken
    )
      violations.add('dynamic import lifecycle module loading is forbidden');
    if (
      token.kind === SyntaxKind.Identifier &&
      token.text !== 'enqueueOutbox' &&
      (FORBIDDEN_IDENTIFIERS.has(token.text) || token.text === 'require')
    )
      violations.add(`forbidden import lifecycle symbol: ${token.text}`);
  }
  return [...violations];
}

async function writerFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await writerFiles(absolute)));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) files.push(absolute);
  }
  return files;
}

async function checkWriter(): Promise<void> {
  const files = await writerFiles(path.resolve('apps/api/src/imports/loader'));
  const imports = [
    ...(await writerFiles(path.resolve('apps/api/src/imports'))),
    ...(await writerFiles(path.resolve('packages/importers/src'))),
    ...(await writerFiles(path.resolve('apps/api/src'))).filter(
      (file) => !file.includes('/imports/') && path.basename(file).includes('import'),
    ),
  ];
  const failures: string[] = [];
  for (const file of files)
    for (const violation of findImportWriterViolations(await readFile(file, 'utf8')))
      failures.push(`${path.relative(process.cwd(), file)}: ${violation}`);
  for (const file of imports)
    for (const violation of findImportLifecycleViolations(await readFile(file, 'utf8')))
      failures.push(`${path.relative(process.cwd(), file)}: ${violation}`);
  if (failures.length) {
    process.stderr.write(`${failures.join('\n')}\n`);
    process.exitCode = 1;
  } else
    process.stdout.write(
      `import writer: ${files.length} strict writer files and ${imports.length} import lifecycle files checked\n`,
    );
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) await checkWriter();
