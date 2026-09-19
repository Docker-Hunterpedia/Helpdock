/**
 * Enforces the rule in ARCHITECTURE §6 and DOMAIN-RULES §1.3: every route
 * handler declares what it needs, with `@Requires(...)`, `@Authenticated()` or
 * `@Public()`. A handler that declares nothing is refused at runtime by the
 * permission guard; this check refuses it in review, which is cheaper.
 *
 * Run with `pnpm check:routes`. Exits non-zero and names every handler.
 *
 * It is a token scan with TypeScript's own scanner rather than a regex: the
 * scanner is what the compiler uses, so a decorator name inside a string or a
 * comment is a `StringLiteral` or trivia and cannot be mistaken for one. A full
 * parse is not available — TypeScript 7's parser is native and its JavaScript
 * API exposes the scanner and the AST types, not `createSourceFile`.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createScanner, SyntaxKind } from 'typescript/unstable/ast';

/** Decorators that turn a method into an HTTP route. */
const ROUTE_DECORATORS = new Set([
  'Get',
  'Post',
  'Put',
  'Patch',
  'Delete',
  'Head',
  'Options',
  'All',
  'Search',
  'Sse',
]);

/** Decorators that satisfy the rule. One of them, on the handler or its class. */
const DECLARATION_DECORATORS = new Set(['Public', 'Authenticated', 'Requires']);

const CONTROLLER_DECORATOR = 'Controller';

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);
const IGNORED_DIRECTORIES = new Set(['node_modules', 'dist', 'build', 'coverage', '.turbo', 'e2e']);
/**
 * Tests are not routes. They are also where the guard's own "a handler that
 * declares nothing is refused" case is proved, which needs a controller that
 * declares nothing.
 */
const TEST_FILE = /\.(?:test|spec)\.tsx?$/;

export interface UndeclaredRoute {
  /** Repository-relative, POSIX-separated path of the file. */
  readonly file: string;
  readonly controller: string;
  readonly handler: string;
  /** The HTTP decorator that made it a route, for the message. */
  readonly route: string;
}

interface Token {
  readonly kind: SyntaxKind;
  readonly text: string;
}

const tokenize = (source: string): Token[] => {
  const scanner = createScanner(true, undefined, source);
  const tokens: Token[] = [];

  for (;;) {
    const kind = scanner.scan();
    if (kind === SyntaxKind.EndOfFile) {
      return tokens;
    }
    tokens.push({ kind, text: scanner.getTokenText() });
  }
};

/** Index just past the `)` that closes the `(` at `start`, or `start` if there is none. */
const skipParens = (tokens: readonly Token[], start: number): number => {
  if (tokens[start]?.kind !== SyntaxKind.OpenParenToken) {
    return start;
  }

  let depth = 0;
  for (let index = start; index < tokens.length; index += 1) {
    const kind = tokens[index]?.kind;
    if (kind === SyntaxKind.OpenParenToken) {
      depth += 1;
    } else if (kind === SyntaxKind.CloseParenToken) {
      depth -= 1;
      if (depth === 0) {
        return index + 1;
      }
    }
  }
  return tokens.length;
};

/**
 * Reads `@Name` or `@Namespace.Name` at `index` and returns the name plus where
 * the decorator ends. Arguments are skipped without being looked at, so a
 * decorator nested in another one's arguments is never collected.
 */
const readDecorator = (
  tokens: readonly Token[],
  index: number,
): { readonly name: string; readonly next: number } | undefined => {
  if (tokens[index]?.kind !== SyntaxKind.AtToken) {
    return undefined;
  }

  let cursor = index + 1;
  let name = tokens[cursor]?.text;
  if (name === undefined || tokens[cursor]?.kind !== SyntaxKind.Identifier) {
    return undefined;
  }
  cursor += 1;

  while (tokens[cursor]?.kind === SyntaxKind.DotToken) {
    name = tokens[cursor + 1]?.text ?? name;
    cursor += 2;
  }

  return { name, next: skipParens(tokens, cursor) };
};

interface ClassFrame {
  readonly name: string;
  readonly isController: boolean;
  readonly declared: boolean;
  readonly bodyDepth: number;
}

/**
 * Every route handler in one file that declares neither a permission nor
 * `@Public()`. Exported so the tests can hand it a source string.
 */
export function findUndeclaredRoutes(params: {
  readonly file: string;
  readonly source: string;
}): UndeclaredRoute[] {
  const tokens = tokenize(params.source);
  const undeclared: UndeclaredRoute[] = [];

  let depth = 0;
  let pending: string[] = [];
  let frame: ClassFrame | undefined;

  for (let index = 0; index < tokens.length; ) {
    const token = tokens[index];
    /* c8 ignore next 3 -- the loop condition already bounds `index`. */
    if (token === undefined) {
      break;
    }

    const decorator = readDecorator(tokens, index);
    if (decorator !== undefined) {
      pending.push(decorator.name);
      index = decorator.next;
      continue;
    }

    switch (token.kind) {
      case SyntaxKind.ClassKeyword: {
        const name = tokens[index + 1]?.text ?? '(anonymous)';
        frame = {
          name,
          isController: pending.includes(CONTROLLER_DECORATOR),
          declared: pending.some((decoratorName) => DECLARATION_DECORATORS.has(decoratorName)),
          bodyDepth: depth + 1,
        };
        pending = [];
        index += 2;
        continue;
      }
      case SyntaxKind.OpenBraceToken:
        depth += 1;
        pending = [];
        index += 1;
        continue;
      case SyntaxKind.CloseBraceToken:
        depth -= 1;
        pending = [];
        if (frame !== undefined && depth < frame.bodyDepth) {
          frame = undefined;
        }
        index += 1;
        continue;
      case SyntaxKind.SemicolonToken:
        pending = [];
        index += 1;
        continue;
      default:
        break;
    }

    // A method is a name followed by `(` at the depth of the class body. A
    // property holding a function is `name = (…) =>`, which the `=` rules out.
    const isMember =
      frame !== undefined &&
      depth === frame.bodyDepth &&
      token.kind === SyntaxKind.Identifier &&
      tokens[index + 1]?.kind === SyntaxKind.OpenParenToken;

    if (!isMember || frame === undefined) {
      index += 1;
      continue;
    }

    const finding = undeclaredRoute({
      file: params.file,
      frame,
      handler: token.text,
      decorators: pending,
    });
    if (finding !== undefined) {
      undeclared.push(finding);
    }

    pending = [];
    // Past the parameter list, so parameter decorators are never collected.
    index = skipParens(tokens, index + 1);
  }

  return undeclared;
}

/** Whether this member is a route handler that declared nothing. */
const undeclaredRoute = ({
  file,
  frame,
  handler,
  decorators,
}: {
  readonly file: string;
  readonly frame: ClassFrame;
  readonly handler: string;
  readonly decorators: readonly string[];
}): UndeclaredRoute | undefined => {
  if (!frame.isController) {
    return undefined;
  }

  const route = decorators.find((name) => ROUTE_DECORATORS.has(name));
  const declared = frame.declared || decorators.some((name) => DECLARATION_DECORATORS.has(name));

  return route === undefined || declared
    ? undefined
    : { file, controller: frame.name, handler, route };
};

async function collectSourceFiles(directory: string, repoRoot: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name)) {
        files.push(...(await collectSourceFiles(absolute, repoRoot)));
      }
      continue;
    }

    if (SOURCE_EXTENSIONS.has(path.extname(entry.name)) && !TEST_FILE.test(entry.name)) {
      files.push(path.relative(repoRoot, absolute).split(path.sep).join('/'));
    }
  }

  return files;
}

function formatUndeclared(route: UndeclaredRoute): string {
  return `  ${route.file}: ${route.controller}.${route.handler} is @${route.route}() with no @Requires, @Authenticated or @Public`;
}

async function main(): Promise<void> {
  const repoRoot = path.resolve(import.meta.dirname, '..');
  const appsRoot = path.join(repoRoot, 'apps');

  const apps = (await readdir(appsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(appsRoot, entry.name, 'src'));

  const files: string[] = [];
  for (const root of apps) {
    // An app that has no `src/` yet is a placeholder, not a failure. Anything
    // else — a permissions problem, a broken symlink — has to stop the check,
    // or it would silently scan nothing and report success.
    const scanned = await collectSourceFiles(root, repoRoot).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') {
          return [];
        }
        throw error;
      },
    );
    files.push(...scanned);
  }

  const undeclared: UndeclaredRoute[] = [];
  for (const file of files) {
    const source = await readFile(path.join(repoRoot, file), 'utf8');
    undeclared.push(...findUndeclaredRoutes({ file, source }));
  }

  if (undeclared.length > 0) {
    console.error(
      `Every route handler must declare @Requires(...), @Authenticated() or @Public() (DOMAIN-RULES §1.3).\n${undeclared
        .map(formatUndeclared)
        .join('\n')}`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(`route permissions: ${files.length} files checked, every route declares one`);
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && path.resolve(invokedPath) === import.meta.filename) {
  await main();
}
