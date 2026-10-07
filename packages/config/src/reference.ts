import { COMPOSE_SECTION_MARKER, type EnvKey, envSchema } from './env.js';
import { SETTING_DEFINITIONS } from './registry.js';

/**
 * Renders `docs/guides/configuration.md` from the three places configuration is
 * defined: the bootstrap schema (required or not, and the default), the
 * comments in `.env.example` (what each key is for), and the settings registry
 * (every `HD_*` override). `reference.test.ts` compares the page with this
 * output, so a key added to any of them without the page being regenerated
 * fails the unit tests.
 */

interface EnvBlock {
  readonly keys: readonly { readonly name: string; readonly example: string }[];
  readonly prose: string;
}

const KEY_LINE = /^([A-Z][A-Z0-9_]*)=(.*)$/;

const proseOf = (comments: readonly string[]): string =>
  comments
    .map((line) => line.replace(/^# ?/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/**
 * Splits one section of `.env.example` into its documented keys. A paragraph
 * (lines up to a blank one) that ends in `KEY=value` lines documents those keys
 * with the comment above them; a paragraph of comments alone documents nothing
 * that is set, and is left to the hand-written parts of the page.
 */
export const parseEnvExample = (section: string): readonly EnvBlock[] =>
  section
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.split('\n').filter((line) => line.trim() !== ''))
    .flatMap((lines): EnvBlock[] => {
      const keys = lines.flatMap((line) => {
        const match = KEY_LINE.exec(line);
        return match === null ? [] : [{ name: match[1] ?? '', example: match[2] ?? '' }];
      });
      if (keys.length === 0) {
        return [];
      }
      return [{ keys, prose: proseOf(lines.filter((line) => line.startsWith('#'))) }];
    });

const isBootstrapKey = (name: string): name is EnvKey => name in envSchema.shape;

const code = (value: string): string => (value === '' ? '—' : `\`${value}\``);

const cell = (value: string): string => value.replaceAll('|', '\\|').replaceAll('\n', ' ');

interface Requirement {
  readonly required: string;
  readonly default: string;
}

/** "yes", or "no" with the default the schema fills in, when it has one. */
const bootstrapRequirement = (name: EnvKey): Requirement => {
  const parsed = envSchema.shape[name].safeParse(undefined);
  if (!parsed.success) {
    return { required: 'yes', default: '—' };
  }
  const value = parsed.data;
  if (value === undefined) {
    return { required: 'no', default: '—' };
  }
  return {
    required: 'no',
    default: code(Array.isArray(value) ? value.join(',') : String(value)),
  };
};

const REFERENCE_OPEN = '${';
const REFERENCE_CLOSE = '}';
const REFERENCE_NAME = /^([A-Z][A-Z0-9_]*)(?::([-?]))?/;

interface ComposeReference {
  readonly name: string;
  readonly operator: string | undefined;
  readonly value: string;
}

/** Every `${NAME}`, `${NAME:?…}` and `${NAME:-…}` in the file, in one pass. */
const composeReferences = (composeFile: string): ComposeReference[] => {
  const references: ComposeReference[] = [];
  let from = 0;
  let close = -1;
  for (;;) {
    const open = composeFile.indexOf(REFERENCE_OPEN, from);
    if (open === -1) {
      return references;
    }
    // The closing brace found for an earlier opener still closes this one.
    if (close < open) {
      close = composeFile.indexOf(REFERENCE_CLOSE, open);
      if (close === -1) {
        return references;
      }
    }
    from = open + REFERENCE_OPEN.length;
    const inside = composeFile.slice(from, close);
    const head = REFERENCE_NAME.exec(inside);
    if (head?.[1] === undefined) {
      continue;
    }
    const [matched, name, operator] = head;
    if (operator === undefined && matched.length !== inside.length) {
      continue;
    }
    references.push({ name, operator, value: inside.slice(matched.length) });
    from = close + REFERENCE_CLOSE.length;
  }
};

/**
 * What `docker-compose.yml` does without the key: `${KEY:?…}` refuses to
 * start, `${KEY:-value}` falls back to the value.
 */
export const composeRequirements = (composeFile: string): ReadonlyMap<string, Requirement> => {
  const found = new Map<string, Requirement>();
  for (const { name, operator, value } of composeReferences(composeFile)) {
    if (operator === '?') {
      found.set(name, { required: 'yes', default: '—' });
    } else if (operator === '-' && found.get(name)?.required !== 'yes') {
      found.set(name, { required: 'no', default: code(value) });
    }
  }
  return found;
};

const renderBlock =
  (requirementOf: (name: string) => Requirement) =>
  ({ keys, prose }: EnvBlock): string => {
    const rows = keys.map(({ name, example }) => {
      const { required, default: fallback } = requirementOf(name);
      return `| \`${name}\` | ${required} | ${fallback} | ${code(example)} |`;
    });

    return [
      `### ${keys.map(({ name }) => name).join(', ')}`,
      '',
      '| Key | Required | Default | In `.env.example` |',
      '|---|---|---|---|',
      ...rows,
      '',
      prose,
    ].join('\n');
  };

const settingDefault = (value: unknown): string =>
  code(typeof value === 'string' ? value : JSON.stringify(value));

const renderSettings = (): string =>
  [
    '| Variable | Setting | Scope | Secret | Default | What it is |',
    '|---|---|---|---|---|---|',
    ...SETTING_DEFINITIONS.map(
      (definition) =>
        `| \`${definition.envKey}\` | \`${definition.key}\` | ${definition.scope} | ${definition.secret ? 'yes' : 'no'} | ${cell(settingDefault(definition.default))} | ${cell(definition.description)} |`,
    ),
  ].join('\n');

const INTRO = `# Configuration reference

<!-- Generated from packages/config (env.ts, registry.ts) and .env.example.
     Do not edit by hand: change those, then run
     pnpm vitest run --project @helpdock/config reference -u -->

Every key Helpdock reads, in three layers
([ARCHITECTURE §4](../planning/ARCHITECTURE.md#4-configuration-model)):

1. **Bootstrap keys** in \`.env\`: what the process needs before it can read the
   database. Checked at boot by \`loadEnv\` (\`packages/config/src/env.ts\`); a
   missing or invalid key stops the api and the worker with one message naming
   every key at fault, never its value.
2. **Compose keys** in the same \`.env\`, read by \`docker/docker-compose.yml\`
   and not by the application.
3. **Settings**, edited in admin and stored in the \`settings\` table. Any of
   them can be pinned from the environment with its \`HD_*\` variable, which
   overrides the database and locks the field in admin.

Start from \`.env.example\`: \`cp .env.example docker/.env\`. An empty value
counts as unset. The [install guide](install.md#install) says which keys a
first install must fill in.`;

const TRACING = `## Tracing

Tracing uses the standard OpenTelemetry variables rather than Helpdock ones
(\`apps/api/src/observability/tracing.ts\`):

| Variable | What it does |
|---|---|
| \`OTEL_EXPORTER_OTLP_ENDPOINT\` | A collector's base URL, for example \`http://otel-collector:4318\`. Set, the api and the worker export spans over OTLP/HTTP; unset, nothing is traced. |
| \`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT\` | A traces-only endpoint, which wins over the one above. |
| \`OTEL_SERVICE_NAME\` | Overrides the default \`helpdock-api\` / \`helpdock-worker\`. |

[Operations › Tracing](operations.md#tracing) has the rest.`;

const DEVELOPMENT = `## Development only

\`HD_DEV_PRINCIPAL_HEADER=1\`, with \`NODE_ENV\` other than \`production\`, makes the
api read a whole principal from the \`x-hd-dev-principal\` request header instead
of verifying a session (\`apps/api/src/auth/principal-resolver.ts\`). Anyone who
can reach the port can then name themselves an install admin. The api refuses
it under \`NODE_ENV=production\`. Never set it on an install.`;

/**
 * The whole of `docs/guides/configuration.md`, given the text of `.env.example`
 * and of `docker/docker-compose.yml`.
 */
export const renderConfigurationReference = (envExample: string, composeFile: string): string => {
  const [bootstrap = '', compose = ''] = envExample.split(COMPOSE_SECTION_MARKER);
  const composed = composeRequirements(composeFile);
  const unread: Requirement = { required: 'unread', default: '—' };

  return `${[
    INTRO,
    '## Bootstrap keys',
    ...parseEnvExample(bootstrap).map(
      renderBlock((name) => (isBootstrapKey(name) ? bootstrapRequirement(name) : unread)),
    ),
    '## Compose keys',
    'Read by `docker/docker-compose.yml` only; `packages/config` does not know them. **Required** means Compose refuses to start without the key; the default is the one the Compose file falls back to.',
    ...parseEnvExample(compose).map(renderBlock((name) => composed.get(name) ?? unread)),
    '## Settings you can pin with `HD_*`',
    "Every setting in the registry (`packages/config/src/registry.ts`). **Scope** `brand` means a brand can override the install's value in admin. A **secret** is encrypted under `APP_MASTER_KEY` when stored, never logged and never sent to a browser; pinned in `.env`, it is not stored at all. JSON-valued settings (`HD_AI_PROVIDERS`) take JSON.",
    renderSettings(),
    TRACING,
    DEVELOPMENT,
  ].join('\n\n')}\n`;
};
