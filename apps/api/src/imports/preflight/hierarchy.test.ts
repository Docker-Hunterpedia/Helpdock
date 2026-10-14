import { importRecordSchema } from '@helpdock/schemas';
import { expect, it } from 'vitest';
import { importHierarchyCycle } from './hierarchy.js';

const category = (id: string, parent?: string) =>
  importRecordSchema.parse({
    entity: 'category',
    payload: { externalId: id, names: { en: id }, ...(parent ? { parentExternalId: parent } : {}) },
  });
it('finds a cycle reached through an otherwise valid ancestry prefix', async () => {
  const records = new Map([
    ['a', category('a', 'b')],
    ['b', category('b', 'c')],
    ['c', category('c', 'b')],
  ]);
  expect(
    await importHierarchyCycle(category('root', 'a'), async (id) => records.get(id) ?? null),
  ).toEqual(['b', 'c', 'b']);
});
it('accepts a long rooted ancestry without imposing an artificial depth cutoff', async () => {
  const records = new Map(
    Array.from({ length: 2000 }, (_, index) => [
      `n-${index}`,
      category(`n-${index}`, index === 1999 ? undefined : `n-${index + 1}`),
    ]),
  );
  expect(
    await importHierarchyCycle(category('root', 'n-0'), async (id) => records.get(id) ?? null),
  ).toBeNull();
});
it('leaves a missing staged ancestor to the separate dependency validator', async () => {
  expect(await importHierarchyCycle(category('root', 'baseline'), async () => null)).toBeNull();
});

it.each(['section', 'article'] as const)(
  'finds a two-record cycle in %s ancestry',
  async (entity) => {
    const build = (id: string, parent: string) =>
      entity === 'section'
        ? importRecordSchema.parse({
            entity,
            payload: {
              externalId: id,
              parentExternalId: 'category',
              parentSectionExternalId: parent,
              names: { en: id },
            },
          })
        : importRecordSchema.parse({
            entity,
            payload: {
              externalId: id,
              sectionExternalId: 'section',
              translationOf: parent,
              locale: 'en',
              title: id,
              bodyHtml: '<p>Body</p>',
              draft: true,
              internal: true,
              createdAt: '2020-01-01T00:00:00Z',
              updatedAt: '2020-01-01T00:00:00Z',
            },
          });
    const records = new Map([
      ['a', build('a', 'b')],
      ['b', build('b', 'a')],
    ]);
    expect(
      await importHierarchyCycle(build('a', 'b'), async (id) => records.get(id) ?? null),
    ).toEqual(['a', 'b', 'a']);
  },
);
