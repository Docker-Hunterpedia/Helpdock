import type { Context } from '@mariozechner/pi-ai';

/**
 * "No tool/actions in v1 — the AI can only read knowledge and write text"
 * (REQUIREMENTS §4.7). `complete()` never builds a context with tools, and
 * this check runs on the context it is about to send, so a later change that
 * adds them fails loudly instead of quietly giving a model an action.
 */
export class ToolsNotAllowedError extends Error {
  constructor(names: readonly string[]) {
    super(`AI calls may not offer tools in v1; this one offered ${names.join(', ')}`);
    this.name = 'ToolsNotAllowedError';
  }
}

export const assertNoTools = (context: Context): void => {
  const tools = context.tools ?? [];
  if (tools.length > 0) {
    throw new ToolsNotAllowedError(tools.map((tool) => tool.name));
  }
};
