import { pathToFileURL } from 'node:url';
import { createKeyring, type Env, loadEnv } from '@helpdock/config';
import { createDb, type RotationReport, rotateMasterKey } from '@helpdock/db';

/**
 * Operator commands that run against an install from inside its image:
 *
 *   docker compose exec api node dist/cli.js keys rotate
 *
 * Each reads the same `.env` as the api, so it needs nothing passed to it.
 * Output names places and counts, never a value or a key.
 */

const USAGE = `Usage: node dist/cli.js <command>

Commands:
  keys rotate   Re-encrypt every stored secret under APP_MASTER_KEY, reading
                values written under APP_MASTER_KEY_PREVIOUS (DOMAIN-RULES §10).
                Without APP_MASTER_KEY_PREVIOUS it changes nothing and fails if
                any value still needs it.
`;

export interface CliIo {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

export interface CliDeps {
  readonly loadEnv: () => Env;
  readonly rotate: (env: Env) => Promise<RotationReport>;
}

const rotateWithEnv = async (env: Env): Promise<RotationReport> => {
  const { db, close } = createDb({ url: env.DATABASE_URL, max: 1 });
  try {
    return await rotateMasterKey(db, createKeyring(env));
  } finally {
    await close();
  }
};

const DEFAULT_DEPS: CliDeps = { loadEnv, rotate: rotateWithEnv };

export const formatRotationReport = (report: RotationReport): string => {
  const width = Math.max(...report.counts.map(({ place }) => place.length));
  const lines = report.counts.map(
    ({ place, rotated, current }) =>
      `  ${place.padEnd(width)}  ${String(rotated).padStart(6)} rotated  ${String(current).padStart(6)} already current`,
  );
  const from = report.previousKeyId === null ? 'no previous key' : `key ${report.previousKeyId}`;

  return [
    `Master key rotation: ${from} -> key ${report.currentKeyId}`,
    ...lines,
    `${report.rotated} value(s) re-encrypted. Every stored secret now opens with APP_MASTER_KEY.`,
    '',
  ].join('\n');
};

/** Runs one command and returns the process exit code. */
export const runCli = async (
  argv: readonly string[],
  io: CliIo,
  deps: CliDeps = DEFAULT_DEPS,
): Promise<number> => {
  const [group, command, ...rest] = argv;
  if (group !== 'keys' || command !== 'rotate' || rest.length > 0) {
    io.err(USAGE);
    return 2;
  }

  try {
    io.out(formatRotationReport(await deps.rotate(deps.loadEnv())));
    return 0;
  } catch (error) {
    io.err(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCli(process.argv.slice(2), {
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  });
}
