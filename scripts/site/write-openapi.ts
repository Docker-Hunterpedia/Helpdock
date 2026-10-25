/**
 * Writes the api's OpenAPI 3.1 document for the website's API reference
 * (docs/guides/website.md). The document is built by the same function the api
 * serves at /api/docs/openapi.json, from the Zod schemas its routes validate
 * with, so the reference cannot drift from the code. Needs @helpdock/schemas
 * built; the website's build script builds it first.
 *
 * node scripts/site/write-openapi.ts [output]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOpenApiDocument } from '../../apps/api/src/api-v1/openapi.ts';

const output =
  process.argv[2] ??
  fileURLToPath(new URL('../../site/src/generated/openapi.json', import.meta.url));
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`);
console.log(`Wrote the OpenAPI document to ${output}`);
