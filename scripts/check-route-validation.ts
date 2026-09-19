/**
 * Enforces "Zod at every boundary" (ARCHITECTURE §6, step 4) for HTTP input:
 * every `@Param`, `@Query` or `@Body` parameter of a controller handler names
 * its schema, as `@Body(new ZodValidationPipe(Dto))`.
 *
 * Why naming it is not optional (issue #36): nestjs-zod's *global*
 * `ZodValidationPipe` finds a DTO's schema through the `design:paramtypes`
 * metadata the compiler emits for a decorated parameter. An `import type` —
 * which Biome's `useImportType` writes by itself for a DTO used only as a type —
 * erases that metadata, and a transform that never emits it (esbuild, which
 * Vitest uses) removes it everywhere at once. Validation then stops silently:
 * the handler is handed whatever arrived, and the only sign is a 400 that no
 * longer happens.
 *
 * Naming the schema on the parameter is the same pipe with the same schema,
 * decided at the call site instead of inferred, so the route validates wherever
 * it runs. This check is what keeps that true for the next route somebody adds.
 *
 * Run with `pnpm check:validation`. Exits non-zero and names every parameter.
 *
 * Only `@Controller` classes. A `@WebSocketGateway` takes `@MessageBody() body:
 * unknown` and parses it inside the handler with `parseMessage(schema, body)`,
 * because a pipe cannot answer through an acknowledgement; the type is the
 * contract there, and the compiler checks it.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  appSourceFiles,
  forEachMethod,
  type MethodSite,
  ROUTE_DECORATORS,
  readDecorator,
  SyntaxKind,
  type Token,
} from './controller-scan.ts';

/** Parameter decorators that hand a handler something the caller chose. */
const INPUT_DECORATORS = new Set(['Param', 'Query', 'Body']);

/** The pipe that has to appear in their arguments. */
const VALIDATION_PIPE = 'ZodValidationPipe';

export interface UnvalidatedParameter {
  /** Repository-relative, POSIX-separated path of the file. */
  readonly file: string;
  readonly className: string;
  readonly handler: string;
  /** `Param`, `Query` or `Body`. */
  readonly decorator: string;
  /** The decorator's arguments as written, for the message. */
  readonly argument: string;
}

/**
 * Whether the decorator's arguments name the validation pipe. An identifier,
 * never a string: a comment or a string that happens to contain the pipe's name
 * is trivia or a `StringLiteral` to the scanner and cannot be mistaken for one.
 */
const namesThePipe = (argumentTokens: readonly Token[]): boolean =>
  argumentTokens.some(
    (token) => token.kind === SyntaxKind.Identifier && token.text === VALIDATION_PIPE,
  );

/** The input parameters of one handler that are not parsed by a named schema. */
const unvalidatedParametersOf = (file: string, method: MethodSite): UnvalidatedParameter[] => {
  const findings: UnvalidatedParameter[] = [];
  const { parameterTokens } = method;

  for (let index = 0; index < parameterTokens.length; ) {
    const decorator = readDecorator(parameterTokens, index);
    if (decorator === undefined) {
      index += 1;
      continue;
    }

    if (INPUT_DECORATORS.has(decorator.name) && !namesThePipe(decorator.argumentTokens)) {
      findings.push({
        file,
        className: method.className,
        handler: method.name,
        decorator: decorator.name,
        argument: decorator.argumentTokens.map((token) => token.text).join(''),
      });
    }

    index = decorator.next;
  }

  return findings;
};

/**
 * Every controller handler parameter in one file that takes caller input
 * without naming a schema. Exported so the tests can hand it a source string.
 */
export function findUnvalidatedParameters(params: {
  readonly file: string;
  readonly source: string;
}): UnvalidatedParameter[] {
  const findings: UnvalidatedParameter[] = [];

  forEachMethod(params, (method) => {
    const isRoute =
      method.classDecorators.includes('Controller') &&
      method.decorators.some((name) => ROUTE_DECORATORS.has(name));

    if (isRoute) {
      findings.push(...unvalidatedParametersOf(params.file, method));
    }
  });

  return findings;
}

function formatUnvalidated(parameter: UnvalidatedParameter): string {
  return `  ${parameter.file}: ${parameter.className}.${parameter.handler} takes @${parameter.decorator}(${parameter.argument}) with no new ${VALIDATION_PIPE}(...)`;
}

async function main(): Promise<void> {
  const repoRoot = path.resolve(import.meta.dirname, '..');
  const files = await appSourceFiles(repoRoot);

  const unvalidated: UnvalidatedParameter[] = [];
  for (const file of files) {
    const source = await readFile(path.join(repoRoot, file), 'utf8');
    unvalidated.push(...findUnvalidatedParameters({ file, source }));
  }

  if (unvalidated.length > 0) {
    console.error(
      `Every @Param, @Query and @Body on a controller handler must name its schema, as @Body(new ${VALIDATION_PIPE}(Dto)) (ARCHITECTURE §6; issue #36).\n${unvalidated
        .map(formatUnvalidated)
        .join('\n')}`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `route validation: ${files.length} files checked, every @Param, @Query and @Body names its schema`,
  );
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && path.resolve(invokedPath) === import.meta.filename) {
  await main();
}
