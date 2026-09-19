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
 * Run with `pnpm check:routes`. Exits non-zero and names every handler. It
 * walks with `controller-scan.ts`, shared with `check-route-validation.ts`.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  appSourceFiles,
  forEachMethod,
  HANDLER_HOST_DECORATORS,
  type MethodSite,
  ROUTE_DECORATORS,
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

const declares = (decorators: readonly string[]): boolean =>
  decorators.some((name) => DECLARATION_DECORATORS.has(name));

/** Whether this method is a handler that declared nothing. */
const undeclaredRoute = (file: string, method: MethodSite): UndeclaredRoute | undefined => {
  if (!method.classDecorators.some((name) => HANDLER_HOST_DECORATORS.has(name))) {
    return undefined;
  }

  const route = method.decorators.find((name) => ROUTE_DECORATORS.has(name));
  if (route === undefined || declares(method.classDecorators) || declares(method.decorators)) {
    return undefined;
  }

  return { file, className: method.className, handler: method.name, route };
};

/**
 * Every route or socket-event handler in one file that declares neither a
 * permission nor `@Public()`. Exported so the tests can hand it a source string.
 */
export function findUndeclaredRoutes(params: {
  readonly file: string;
  readonly source: string;
}): UndeclaredRoute[] {
  const undeclared: UndeclaredRoute[] = [];

  forEachMethod(params, (method) => {
    const finding = undeclaredRoute(params.file, method);
    if (finding !== undefined) {
      undeclared.push(finding);
    }
  });

  return undeclared;
}

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
