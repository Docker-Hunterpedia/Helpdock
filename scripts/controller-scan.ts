/**
 * The token scanner both route checks share.
 *
 * `check-route-permissions.ts` asks whether a handler declared a permission;
 * `check-route-validation.ts` asks whether its input is parsed. Both questions
 * are answered by walking the same token stream over the same files, so the
 * walking lives here and each check keeps only its own rule.
 *
 * It is a token scan with TypeScript's own scanner rather than a regex: the
 * scanner is what the compiler uses, so a decorator name inside a string or a
 * comment is a `StringLiteral` or trivia and cannot be mistaken for one. A full
 * parse is not available — TypeScript 7's parser is native and its JavaScript
 * API exposes the scanner and the AST types, not `createSourceFile`.
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { createScanner, SyntaxKind } from 'typescript/unstable/ast';

export { SyntaxKind };

/** Decorators that turn a method into an HTTP route or a socket event handler. */
export const ROUTE_DECORATORS: ReadonlySet<string> = new Set([
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
  'SubscribeMessage',
]);

/** Class decorators that make a class a place route handlers may live. */
export const HANDLER_HOST_DECORATORS: ReadonlySet<string> = new Set([
  'Controller',
  'WebSocketGateway',
]);

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);
const IGNORED_DIRECTORIES = new Set(['node_modules', 'dist', 'build', 'coverage', '.turbo', 'e2e']);
/**
 * Tests are not routes. They are also where each check's own refusal is proved,
 * which needs a controller that breaks the rule on purpose.
 */
const TEST_FILE = /\.(?:test|spec)\.tsx?$/;

export interface Token {
  readonly kind: SyntaxKind;
  readonly text: string;
}

/**
 * `scan()` alone cannot read a template literal with a substitution in it: it
 * stops at `${`, and the `}` that ends the substitution comes back as an
 * ordinary closing brace. Everything after it — the template's own text — is
 * then scanned as if it were code, which both corrupts the brace depth these
 * checkers track and can stall the scanner outright, because text like a CSS
 * colour reads as an invalid private identifier that consumes nothing.
 *
 * Rescanning that brace as the next template span is what the compiler's own
 * parser does, and it keeps template text out of the token stream entirely.
 */
export const tokenize = (source: string, file: string): Token[] => {
  const scanner = createScanner(true, undefined, source);
  const tokens: Token[] = [];
  let templateDepth = 0;
  let lastEnd = -1;

  for (;;) {
    let kind = scanner.scan();
    if (kind === SyntaxKind.EndOfFile) {
      return tokens;
    }

    if (kind === SyntaxKind.CloseBraceToken && templateDepth > 0) {
      kind = scanner.reScanTemplateToken(false);
    }
    if (kind === SyntaxKind.TemplateHead) {
      templateDepth += 1;
    } else if (kind === SyntaxKind.TemplateTail) {
      templateDepth -= 1;
    }

    // A scanner that returns a token without consuming anything would loop
    // until the process runs out of memory. Saying where it stopped is the
    // difference between a fixable report and a heap dump.
    const end = scanner.getTokenEnd();
    if (end <= lastEnd) {
      throw new Error(
        `${file}: the scanner stopped making progress at offset ${String(end)}; this file cannot be checked`,
      );
    }
    lastEnd = end;

    tokens.push({ kind, text: scanner.getTokenText() });
  }
};

/** Index just past the `)` that closes the `(` at `start`, or `start` if there is none. */
export const skipParens = (tokens: readonly Token[], start: number): number => {
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

export interface ReadDecorator {
  readonly name: string;
  /** The tokens between the decorator's own `(` and `)`; empty when it has none. */
  readonly argumentTokens: readonly Token[];
  /** Index of the first token after the decorator and its arguments. */
  readonly next: number;
}

/**
 * Reads `@Name` or `@Namespace.Name` at `index` and returns the name, its
 * argument tokens and where the decorator ends. A caller that resumes at `next`
 * never sees a decorator nested in another one's arguments.
 */
export const readDecorator = (
  tokens: readonly Token[],
  index: number,
): ReadDecorator | undefined => {
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

  const next = skipParens(tokens, cursor);
  const argumentTokens = next === cursor ? [] : tokens.slice(cursor + 1, next - 1);

  return { name, argumentTokens, next };
};

export interface MethodSite {
  readonly className: string;
  /** Decorator names on the class itself: `Controller`, `Requires`, … */
  readonly classDecorators: readonly string[];
  readonly name: string;
  /** Decorator names on the method itself: `Get`, `Public`, … */
  readonly decorators: readonly string[];
  /** The tokens between the method's own `(` and its `)`. */
  readonly parameterTokens: readonly Token[];
}

/**
 * Calls `visit` for every method of every class in one file, with the
 * decorators of both and the method's parameter list. Which of those count as a
 * route, and what a route then has to carry, is each check's own rule.
 *
 * A method is a name followed by `(` at the depth of the class body. A property
 * holding a function is `name = (…) =>`, which the `=` rules out.
 */
export function forEachMethod(
  params: { readonly file: string; readonly source: string },
  visit: (site: MethodSite) => void,
): void {
  const tokens = tokenize(params.source, params.file);

  let depth = 0;
  let pending: string[] = [];
  let frame:
    | { readonly name: string; readonly decorators: string[]; readonly bodyDepth: number }
    | undefined;

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
        frame = {
          name: tokens[index + 1]?.text ?? '(anonymous)',
          decorators: pending,
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

    const isMethod =
      frame !== undefined &&
      depth === frame.bodyDepth &&
      token.kind === SyntaxKind.Identifier &&
      tokens[index + 1]?.kind === SyntaxKind.OpenParenToken;

    if (!isMethod || frame === undefined) {
      index += 1;
      continue;
    }

    const afterParameters = skipParens(tokens, index + 1);
    visit({
      className: frame.name,
      classDecorators: frame.decorators,
      name: token.text,
      decorators: pending,
      parameterTokens: tokens.slice(index + 2, afterParameters - 1),
    });

    pending = [];
    // Past the parameter list, so a parameter's decorators are never read as
    // the next method's.
    index = afterParameters;
  }
}

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

/** Every non-test source file under an app's `src/`, repository-relative and POSIX-separated. */
export async function appSourceFiles(repoRoot: string): Promise<string[]> {
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

  return files;
}
