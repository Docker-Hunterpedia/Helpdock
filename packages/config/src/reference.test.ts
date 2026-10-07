import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ENV_KEYS } from './env.js';
import { composeRequirements, parseEnvExample, renderConfigurationReference } from './reference.js';
import { SETTING_DEFINITIONS } from './registry.js';

const envExample = readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8');
const composeFile = readFileSync(
  new URL('../../../docker/docker-compose.yml', import.meta.url),
  'utf8',
);
const render = (): string => renderConfigurationReference(envExample, composeFile);
const PAGE = '../../../docs/guides/configuration.md';

describe('docs/guides/configuration.md', () => {
  it('is what the schema, the registry and .env.example render to', async () => {
    // Regenerate with: pnpm vitest run --project @helpdock/config reference -u
    await expect(render()).toMatchFileSnapshot(PAGE);
  });

  it('documents every bootstrap key and every HD_ setting', () => {
    const page = render();

    for (const key of ENV_KEYS) {
      expect(page, key).toContain(`| \`${key}\` |`);
    }
    for (const { envKey } of SETTING_DEFINITIONS) {
      expect(page, envKey).toContain(`| \`${envKey}\` |`);
    }
  });

  it('marks a required key, a defaulted one and a Compose one apart', () => {
    const page = render();

    expect(page).toContain('| `APP_MASTER_KEY` | yes | — |');
    expect(page).toContain('| `PORT` | no | `3000` |');
    expect(page).toContain('| `APP_MASTER_KEY_PREVIOUS` | no | — |');
    expect(page).toContain('| `POSTGRES_PASSWORD` | yes | — |');
    expect(page).toContain('| `POSTGRES_USER` | no | `helpdock_owner` |');
  });

  it('documents no key that neither the schema nor the Compose file reads', () => {
    expect(render()).not.toContain('| unread |');
  });
});

describe('parseEnvExample', () => {
  it('gives each key paragraph its comment, and drops paragraphs that set nothing', () => {
    const blocks = parseEnvExample(
      [
        '# Intro that sets nothing.',
        '',
        '# Where the bucket is.',
        '#',
        '# Second paragraph.',
        'S3_ENDPOINT=http://minio:9000',
        'S3_REGION=us-east-1',
        '',
        '#   HD_SMTP_HOST=smtp.example.com',
      ].join('\n'),
    );

    expect(blocks).toEqual([
      {
        keys: [
          { name: 'S3_ENDPOINT', example: 'http://minio:9000' },
          { name: 'S3_REGION', example: 'us-east-1' },
        ],
        prose: 'Where the bucket is.\n\nSecond paragraph.',
      },
    ]);
  });
});

describe('composeRequirements', () => {
  it('reads a refusal as required and a fallback as its default', () => {
    const found = composeRequirements(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Compose interpolation, not a template
      'a: ${NEEDED:?set NEEDED}\nb: ${TAG:-latest}\nc: ${EMPTY:-}\nd: ${NEEDED:-x}',
    );

    expect(Object.fromEntries(found)).toEqual({
      NEEDED: { required: 'yes', default: '—' },
      TAG: { required: 'no', default: '`latest`' },
      EMPTY: { required: 'no', default: '—' },
    });
  });

  it('skips a bare, a lower-case and an unterminated reference, in linear time', () => {
    const started = performance.now();
    const found = composeRequirements(
      `a: \${BARE}\nb: \${lower:-x}\nc: \${BAD-NAME:-x}\nd: \${LAST:-ok}\n${'${A:-|'.repeat(50_000)}`,
    );

    expect(Object.fromEntries(found)).toEqual({ LAST: { required: 'no', default: '`ok`' } });
    expect(performance.now() - started).toBeLessThan(500);
  });
});
