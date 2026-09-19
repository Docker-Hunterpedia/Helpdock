/**
 * Enforces the rule in ARCHITECTURE §6 and DOMAIN-RULES §1.3: every handler
 * declares what it needs, with `@Requires(...)`, `@Authenticated()` or
 * `@Public()`. A handler that declares nothing is refused at runtime by the
 * permission guard; this check refuses it in review, which is cheaper.
 *
 * "HTTP/WebSocket guard: role and scope check per route **or event**" (§1.3),
 * so a `@SubscribeMessage` handler on a `@WebSocketGateway` counts as a route
 * here and is held to the same rule.
 *
 * Run with `pnpm check:routes`. Exits non-zero and names every handler. The
 * scanner it walks with is in `controller-scan.ts`, shared with
 * `check-route-validation.ts`.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  appSourceFiles,
  HANDLER_HOST_DECORATORS,
  ROUTE_DECORATORS,
  readDecorator,
  SyntaxKind,
  skipParens,
  type Token,
  tokenize,
} from './controller-scan.ts';

/** Decorators that satisfy the rule. One of them, on the handler or its class. */
const DECLARATION_DECORATORS = new Set(['Public', 'Authenticated', 'Requires']);

export interface UndeclaredRoute {
  /** Repository-relative, POSIX-separated path of the file. */
  readonly file: string;
  /** The controller or gateway the handler is declared on. */
  readonly className: string;
  readonly handler: string;
  /** The decorator that made it a handler, for the message. */
  readonly route: string;
}

interface ClassFrame {
  readonly name: string;
  /** A `@Controller` or a `@WebSocketGateway`; anything else holds no routes. */
  readonly isHandlerHost: boolean;
  readonly declared: boolean;
  readonly bodyDepth: number;
}

/**
 * Every route or socket-event handler in one file that declares neither a
 * permission nor `@Public()`. Exported so the tests can hand it a source string.
 */
export function findUndeclaredRoutes(params: {
  readonly file: string;
  readonly source: string;
}): UndeclaredRoute[] {
  const tokens = tokenize(params.source, params.file);
  const undeclared: UndeclaredRoute[] = [];

  let depth = 0;
  let pending: string[] = [];
  let frame: ClassFrame | undefined;

  for (let index = 0; index < tokens.length; ) {
    const token: Token | undefined = tokens[index];
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
          isHandlerHost: pending.some((decoratorName) =>
            HANDLER_HOST_DECORATORS.has(decoratorName),
          ),
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

/** Whether this member is a handler that declared nothing. */
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
  if (!frame.isHandlerHost) {
    return undefined;
  }

  const route = decorators.find((name) => ROUTE_DECORATORS.has(name));
  const declared = frame.declared || decorators.some((name) => DECLARATION_DECORATORS.has(name));

  return route === undefined || declared
    ? undefined
    : { file, className: frame.name, handler, route };
};

function formatUndeclared(route: UndeclaredRoute): string {
  return `  ${route.file}: ${route.className}.${route.handler} is @${route.route}() with no @Requires, @Authenticated or @Public`;
}

async function main(): Promise<void> {
  const repoRoot = path.resolve(import.meta.dirname, '..');
  const files = await appSourceFiles(repoRoot);

  const undeclared: UndeclaredRoute[] = [];
  for (const file of files) {
    const source = await readFile(path.join(repoRoot, file), 'utf8');
    undeclared.push(...findUndeclaredRoutes({ file, source }));
  }

  if (undeclared.length > 0) {
    console.error(
      `Every route and socket event handler must declare @Requires(...), @Authenticated() or @Public() (DOMAIN-RULES §1.3).\n${undeclared
        .map(formatUndeclared)
        .join('\n')}`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `route permissions: ${files.length} files checked, every route and socket event declares one`,
  );
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && path.resolve(invokedPath) === import.meta.filename) {
  await main();
}
