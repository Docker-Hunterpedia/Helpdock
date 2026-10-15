import { expect, it } from 'vitest';
import { withinJsonDepth } from './json-depth.js';

it.each([
  [`${'['.repeat(100)}0${']'.repeat(100)}`, true],
  [`${'['.repeat(101)}0${']'.repeat(101)}`, false],
  [JSON.stringify({ text: `${'['.repeat(200)}\\"${']'.repeat(200)}` }), true],
])('bounds recursive JSON while ignoring escaped quoted content', (json, allowed) => {
  expect(withinJsonDepth(json)).toBe(allowed);
});
