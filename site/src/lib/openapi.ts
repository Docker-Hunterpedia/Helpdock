/**
 * Reads the api's OpenAPI 3.1 document (written at build time by
 * scripts/site/write-openapi.ts) into what the API reference page draws:
 * endpoints by tag, their parameters, and request and response bodies as
 * flat field lists.
 */

export type JsonSchema = {
  type?: string | string[];
  format?: string;
  enum?: unknown[];
  const?: unknown;
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  properties?: Record<string, JsonSchema>;
  additionalProperties?: boolean | JsonSchema;
  required?: string[];
  description?: string;
  $ref?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  default?: unknown;
};

export type Field = {
  /** Dotted from the body's root: `contact.email`, `tags[]`. */
  name: string;
  type: string;
  required: boolean;
  notes: string;
};

type Parameter = {
  name: string;
  in: 'path' | 'query' | 'header';
  required: boolean;
  description?: string;
  schema?: JsonSchema;
  content?: Record<string, { schema: JsonSchema }>;
};

type Operation = {
  operationId: string;
  summary: string;
  tags: string[];
  'x-required-scope': string;
  parameters: Parameter[];
  requestBody?: { content: Record<string, { schema: JsonSchema }> };
  responses: Record<
    string,
    { description: string; content?: Record<string, { schema: JsonSchema }> }
  >;
};

export type OpenApiDocument = {
  info: { title: string; version: string; description: string };
  tags: { name: string }[];
  paths: Record<string, Record<string, Operation>>;
  webhooks: Record<
    string,
    { post: { requestBody: { content: Record<string, { schema: JsonSchema }> } } }
  >;
  components: { securitySchemes: { apiKey: { description: string } } };
};

export type Endpoint = {
  id: string;
  method: string;
  path: string;
  summary: string;
  scope: string;
  parameters: (Field & { location: string })[];
  body: Field[];
  success: { status: string; description: string; fields: Field[] };
  errors: { status: string; description: string }[];
};

const MAX_DEPTH = 4;

/** A schema's type as one short line: `string (uuid)`, `"open" | "closed"`, `Ticket[]`. */
export function describeType(schema: JsonSchema): string {
  if (schema.$ref) return schema.$ref.split('/').at(-1) ?? 'object';
  if ('const' in schema) return JSON.stringify(schema.const);
  if (schema.enum) return schema.enum.map((value) => JSON.stringify(value)).join(' | ');
  const variants = schema.anyOf ?? schema.oneOf;
  if (variants) return [...new Set(variants.map(describeType))].join(' | ');
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length === 0) return 'any';
  return types
    .map((type) => {
      if (type === 'array') {
        const item = schema.items ? describeType(schema.items) : 'any';
        return item.includes(' | ') ? `(${item})[]` : `${item}[]`;
      }
      if (type === 'string' && schema.format) return `string (${schema.format})`;
      return type;
    })
    .join(' | ');
}

/** Length, range, size and default limits, as a short note. */
export function constraints(schema: JsonSchema): string {
  const notes: string[] = [];
  if (schema.minLength !== undefined && schema.maxLength !== undefined) {
    notes.push(`${schema.minLength}–${schema.maxLength} characters`);
  } else if (schema.maxLength !== undefined) {
    notes.push(`up to ${schema.maxLength} characters`);
  }
  if (schema.minimum !== undefined || schema.maximum !== undefined) {
    notes.push(`${schema.minimum ?? '…'}–${schema.maximum ?? '…'}`);
  }
  if (schema.maxItems !== undefined) notes.push(`up to ${schema.maxItems} items`);
  if (schema.default !== undefined) notes.push(`default ${JSON.stringify(schema.default)}`);
  return [schema.description, ...notes].filter(Boolean).join('; ');
}

/** The object a schema is, or carries in one of its variants or its array items. */
function objectOf(schema: JsonSchema): JsonSchema | undefined {
  if (schema.properties) return schema;
  if (schema.items) return objectOf(schema.items);
  for (const variant of schema.anyOf ?? schema.oneOf ?? []) {
    const found = objectOf(variant);
    if (found) return found;
  }
  return undefined;
}

/** Every field of a body, nested ones included, flattened with dotted names. */
export function fieldsOf(schema: JsonSchema | undefined, prefix = '', depth = 0): Field[] {
  const object = schema && objectOf(schema);
  if (!object?.properties || depth >= MAX_DEPTH) return [];
  return Object.entries(object.properties).flatMap(([key, property]) => {
    const name = `${prefix}${key}`;
    const childPrefix = `${name}${describeType(property).endsWith('[]') ? '[]' : ''}.`;
    return [
      {
        name,
        type: describeType(property),
        required: (object.required ?? []).includes(key),
        notes: constraints(property),
      },
      ...fieldsOf(property, childPrefix, depth + 1),
    ];
  });
}

const jsonSchemaOf = (content?: Record<string, { schema: JsonSchema }>) =>
  content?.['application/json']?.schema;

export function endpoints(document: OpenApiDocument): { tag: string; endpoints: Endpoint[] }[] {
  const all: (Endpoint & { tag: string })[] = Object.entries(document.paths).flatMap(
    ([path, methods]) =>
      Object.entries(methods).map(([method, operation]) => {
        const [successStatus, success] = Object.entries(operation.responses).find(([status]) =>
          status.startsWith('2'),
        ) ?? ['200', { description: 'OK' }];
        return {
          tag: operation.tags[0] ?? 'Other',
          id: operation.operationId,
          method: method.toUpperCase(),
          path,
          summary: operation.summary,
          scope: operation['x-required-scope'],
          parameters: operation.parameters.map((parameter) => {
            const schema = parameter.schema ?? jsonSchemaOf(parameter.content) ?? {};
            return {
              name: parameter.name,
              location: parameter.in,
              type: describeType(schema),
              required: parameter.required,
              notes: parameter.description ?? constraints(schema),
            };
          }),
          body: fieldsOf(jsonSchemaOf(operation.requestBody?.content)),
          success: {
            status: successStatus,
            description: success.description,
            fields: fieldsOf(jsonSchemaOf(success.content)),
          },
          errors: Object.entries(operation.responses)
            .filter(([status]) => !status.startsWith('2'))
            .map(([status, response]) => ({ status, description: response.description })),
        };
      }),
  );
  return document.tags.map(({ name }) => ({
    tag: name,
    endpoints: all.filter((endpoint) => endpoint.tag === name),
  }));
}

export function webhookEvents(document: OpenApiDocument): { event: string; fields: Field[] }[] {
  return Object.entries(document.webhooks).map(([event, hook]) => ({
    event,
    fields: fieldsOf(jsonSchemaOf(hook.post.requestBody.content)),
  }));
}
