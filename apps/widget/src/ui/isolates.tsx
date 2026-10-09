import type { ComponentChildren } from 'preact';
import type { Vars } from '../i18n/translator.js';

const SLOT = /\{\{(\w+)\}\}/;

/**
 * A translated sentence with each `{{name}}` value in its own `<bdi>`
 * (DESIGN §3.2), so a time, a date or an email keeps its own direction inside
 * a right-to-left sentence. The translator only returns strings, so pass it
 * the template: `t(key)` with no variables leaves the slots in place.
 */
export function withIsolates(template: string, vars: Vars): ComponentChildren {
  // A capturing split puts the slot names at the odd positions.
  return template
    .split(SLOT)
    .map((part, index) => (index % 2 === 1 ? <bdi key={part}>{vars[part] ?? ''}</bdi> : part));
}
