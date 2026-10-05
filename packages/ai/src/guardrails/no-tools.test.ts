import { describe, expect, it } from 'vitest';
import { assertNoTools, ToolsNotAllowedError } from './no-tools.js';

const refund = { name: 'refund', description: 'Issue a refund', parameters: {} as never };

describe('assertNoTools', () => {
  it('lets a context without tools through', () => {
    expect(() => assertNoTools({ messages: [] })).not.toThrow();
    expect(() => assertNoTools({ messages: [], tools: [] })).not.toThrow();
  });

  it('refuses a context that offers a tool, naming it', () => {
    expect(() => assertNoTools({ messages: [], tools: [refund] })).toThrow(ToolsNotAllowedError);
    expect(() => assertNoTools({ messages: [], tools: [refund] })).toThrow(/refund/);
  });
});
