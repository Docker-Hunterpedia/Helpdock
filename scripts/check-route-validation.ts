/**
 * Enforces "Zod at every boundary" (ARCHITECTURE §6, step 4) for HTTP input:
 * every `@Param`, `@Query` or `@Body` parameter of a controller handler names
 * its schema, as `@Body(new ZodValidationPipe(Dto))`.
 *
 * Why naming it is not optional (issue #36): nestjs-zod's *global*
 * `ZodValidationPipe` finds a DTO's schema through the `design:paramtypes`
 * metadata the compiler emits for a decorated parameter. An `import type` — which
 * Biome's `useImportType` writes by itself for a DTO used only as a type — erases
 * that metadata, and a transform that never emits it (esbuild, which Vitest uses)
 * removes it everywhere at once. Validation then stops silently: the handler is
 * handed whatever arrived, and the only sign is a 400 that no longer happens.
 *
 * Naming the schema on the parameter is the same pipe with the same schema,
 * decided at the call site instead of inferred, so the route validates wherever
 * it runs. This check is what keeps that true for the next route somebody adds.
 *
 * Run with `pnpm check:validation`. Exits non-zero and names every parameter.
 *
 * Out of scope, deliberately: socket events. `@MessageBody()` on the `/staff`
 * gateway is typed `unknown` and parsed inside the handler with
 * `parseMessage(schema, body)`, because a pipe cannot answer through an
 * acknowledgement. The type is the contract there, and the compiler checks it.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  appSourceFiles,
  ROUTE_DECORATORS,
  readDecorator,
  SyntaxKind,
  skipParens,
  type Token,
  tokenize,
} from './controller-scan.ts';

/** Parameter decorators that hand a handler something the caller chose. */
const INPUT_DECORATORS = new Set(['Param', 'Query', 'Body']);

/** The pipe that has to appear in their arguments. */
const VALIDATION_PIPE = 'ZodValidationPipe';

/**
 * Only HTTP. A `@WebSocketGateway` has no pipe that can answer through an
 * acknowledgement, so its rule is the one in the file comment above.
 */
const CONTROLLER_DECORATOR = 'Controller';

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

interface ClassFrame {
  readonly name: string;
  readonly isController: boolean;
  readonly bodyDepth: number;
}

const textOf = (tokens: readonly Token[]): string => tokens.map((token) => token.text).join('');

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
const unvalidatedParametersOf = ({
  file,
  className,
  handler,
  parameterTokens,
}: {
  readonly file: string;
  readonly className: string;
  readonly handler: string;
  readonly parameterTokens: readonly Token[];
}): UnvalidatedParameter[] => {
  const findings: UnvalidatedParameter[] = [];

  for (let index = 0; index < parameterTokens.length; ) {
    const decorator = readDecorator(parameterTokens, index);
    if (decorator === undefined) {
      index += 1;
      continue;
    }

    if (INPUT_DECORATORS.has(decorator.name) && !namesThePipe(decorator.argumentTokens)) {
      findings.push({
        file,
        className,
        handler,
        decorator: decorator.name,
        argument: textOf(decorator.argumentTokens),
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
  const tokens = tokenize(params.source, params.file);
  const findings: UnvalidatedParameter[] = [];

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
        frame = {
          name: tokens[index + 1]?.text ?? '(anonymous)',
          isController: pending.includes(CONTROLLER_DECORATOR),
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

    const isMember =
      frame !== undefined &&
      depth === frame.bodyDepth &&
      token.kind === SyntaxKind.Identifier &&
      tokens[index + 1]?.kind === SyntaxKind.OpenParenToken;

    if (!isMember || frame === undefined) {
      index += 1;
      continue;
    }

    const afterParameters = skipParens(tokens, index + 1);
    if (frame.isController && pending.some((name) => ROUTE_DECORATORS.has(name))) {
      findings.push(
        ...unvalidatedParametersOf({
          file: params.file,
          className: frame.name,
          handler: token.text,
          // Between the `(` and its `)`, so the handler's own decorators are
          // never read as its parameters'.
          parameterTokens: tokens.slice(index + 2, afterParameters - 1),
        }),
      );
    }

    pending = [];
    index = afterParameters;
  }

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
