const dates = { createdTime: '2013-11-01T00:00:00.000Z', modifiedTime: '2020-01-01T00:00:00.000Z' };

/** Documented native taxonomy shapes, independent of normalized import schemas. */
export const zohoKnowledgeFixture = {
  roots: [
    {
      ...dates,
      id: '2001',
      name: 'Original help',
      order: '1',
      status: 'SHOW_IN_HELPCENTER',
      isTrashed: false,
      visibility: 'ALL_USERS',
      groups: [],
      translations: [
        {
          id: '3001',
          categoryId: '2001',
          locale: 'en',
          name: 'Original help',
          description: 'Original category description',
        },
        {
          id: '3002',
          categoryId: '2001',
          locale: 'ar',
          name: 'المساعدة الأصلية',
          description: 'وصف التصنيف الأصلي',
        },
      ],
    },
    {
      ...dates,
      id: '2002',
      name: 'Disabled history',
      order: '2',
      status: 'DISABLED',
      isTrashed: false,
      visibility: 'AGENTS',
      groups: [],
      translations: [{ id: '3003', categoryId: '2002', locale: 'en', name: 'Disabled history' }],
    },
    {
      ...dates,
      id: '2003',
      name: 'Trashed history',
      order: '3',
      status: 'HIDE_IN_HELPCENTER',
      isTrashed: true,
      visibility: 'NONE',
      groups: [],
      translations: [{ id: '3004', categoryId: '2003', locale: 'en', name: 'Trashed history' }],
    },
  ],
  sections: [
    {
      ...dates,
      id: '4001',
      rootCategoryId: '2001',
      parentCategoryId: '2001',
      name: 'Original section',
      order: '1',
      status: 'SHOW_IN_HELPCENTER',
      isTrashed: false,
      visibility: 'ALL_USERS',
      groups: [],
      translations: [
        {
          id: '5001',
          categoryId: '4001',
          locale: 'en-US',
          name: 'Original section',
          description: 'Original section description',
        },
        { id: '5002', categoryId: '4001', locale: 'ar-SY', name: 'القسم الأصلي' },
      ],
    },
    {
      ...dates,
      id: '4002',
      rootCategoryId: '2001',
      parentCategoryId: '4001',
      name: 'Nested restricted section',
      order: '2',
      status: 'HIDE_IN_HELPCENTER',
      isTrashed: false,
      visibility: 'GROUP_USERS',
      groups: [{ id: '6001' }],
      translations: [
        { id: '5003', categoryId: '4002', locale: 'en', name: 'Nested restricted section' },
      ],
    },
  ],
};
