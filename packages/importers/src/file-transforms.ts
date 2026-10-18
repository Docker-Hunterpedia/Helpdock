import {
  type ImportAttachmentRef,
  type ImportFileTransform,
  importUrlSchema,
} from '@helpdock/schemas';
import { fileDate } from './file-date.js';

type JsonValue = string | boolean | number | null | JsonValue[] | { [key: string]: JsonValue };
export type FileValue = JsonValue | ImportAttachmentRef[];
export class FileTransformError extends Error {
  constructor(readonly code: 'type-mismatch' | 'unmapped-value' | 'invalid-date') {
    super(code);
  }
}

function jsonValue(text: string): JsonValue {
  let value: JsonValue;
  try {
    value = JSON.parse(text) as JsonValue;
  } catch (error) {
    if (error instanceof SyntaxError) throw new FileTransformError('type-mismatch');
    throw error;
  }
  const stack = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length) {
    const item = stack.pop();
    if (!item) break;
    if (++nodes > 10000 || item.depth > 20) throw new FileTransformError('type-mismatch');
    if (item.value && typeof item.value === 'object') {
      for (const child of Object.values(item.value))
        stack.push({ value: child, depth: item.depth + 1 });
    } else if (typeof item.value === 'number' && !Number.isFinite(item.value))
      throw new FileTransformError('type-mismatch');
  }
  return value;
}

function stringValue(value: FileValue): string {
  if (typeof value !== 'string') throw new FileTransformError('type-mismatch');
  return value;
}

export function transformFileValue(value: FileValue, transform: ImportFileTransform): FileValue {
  if (transform.kind === 'join') {
    if (!Array.isArray(value) || !value.every((part) => typeof part === 'string'))
      throw new FileTransformError('type-mismatch');
    return value.join(transform.separator);
  }
  const text = stringValue(value);
  switch (transform.kind) {
    case 'trim':
      return text.trim();
    case 'number': {
      const trimmed = text.trim();
      if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(trimmed))
        throw new FileTransformError('type-mismatch');
      const value = Number(trimmed);
      if (!Number.isFinite(value)) throw new FileTransformError('type-mismatch');
      return value;
    }
    case 'json':
      return jsonValue(text);
    case 'split':
      return text
        .split(transform.separator)
        .map((part) => part.trim())
        .filter(Boolean);
    case 'attachment-urls':
      return text
        .split(transform.separator)
        .map((part) => part.trim())
        .filter(Boolean)
        .map((address, index) => {
          const parsed = importUrlSchema.safeParse(address);
          if (!parsed.success) throw new FileTransformError('unmapped-value');
          const url = new URL(parsed.data);
          let fileName: string;
          try {
            fileName = decodeURIComponent(url.pathname.split('/').at(-1) || 'attachment');
          } catch (error) {
            if (error instanceof URIError) throw new FileTransformError('unmapped-value');
            throw error;
          }
          return { externalId: `csv-url:${index}`, fileName, url: parsed.data };
        });
    case 'name': {
      const parts = text.trim().split(/\s+/u);
      return transform.part === 'given' ? (parts[0] ?? '') : parts.slice(1).join(' ');
    }
    case 'boolean': {
      if (transform.trueValues.includes(text)) return true;
      if (transform.falseValues.includes(text)) return false;
      throw new FileTransformError('unmapped-value');
    }
    case 'values': {
      const entry = transform.entries.find((candidate) => candidate.from === text);
      if (!entry) throw new FileTransformError('unmapped-value');
      return entry.to;
    }
    case 'date': {
      try {
        return fileDate(text, transform.format, transform.timezone);
      } catch (error) {
        if (
          error instanceof RangeError ||
          (error instanceof Error && ['invalid-date', 'ambiguous-date'].includes(error.message))
        )
          throw new FileTransformError('invalid-date');
        throw error;
      }
    }
  }
}
