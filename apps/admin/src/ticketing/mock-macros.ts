import {
  type Macro,
  type MacroCreateRequest,
  type MacroList,
  type MacroListQuery,
  type MacroUpdateRequest,
  macroShapeProblem,
} from '@helpdock/schemas';
import { MOCK_DEPARTMENTS, MOCK_SELF_ID } from '../staff/mock-api.js';

/**
 * The macros and canned responses the mock adapters share (M3-06): the rows of
 * the artboard `AdminAutomationMacros`, so the Macros tab and the composer's
 * picker draw what the design shows.
 *
 * The status and tag ids are the ones `MockTicketsApi` and `MockTicketingApi`
 * seed, spelled out rather than imported because those two modules import this
 * one.
 */

const [SUPPORT, BILLING] = MOCK_DEPARTMENTS;
/** `MOCK_STATUS_AWAITING` and `MOCK_STATUS_CLOSED` of `tickets/mock-api.ts`. */
const STATUS_AWAITING = '0192c3f0-1a2b-7c3d-8e4f-000000000052';
const STATUS_CLOSED = '0192c3f0-1a2b-7c3d-8e4f-000000000054';
/** The Refund and Bug tags of `ticketing/mock-api.ts`. */
const TAG_REFUND = '0192c3f0-1a2b-7c3d-8e4f-000000000101';
const TAG_BUG = '0192c3f0-1a2b-7c3d-8e4f-000000000103';

export const MOCK_MACRO_REFUND = '0192c3f0-1a2b-7c3d-8e4f-000000000701';
export const MOCK_MACRO_SHIPPING = '0192c3f0-1a2b-7c3d-8e4f-000000000702';
export const MOCK_MACRO_PERSONAL = '0192c3f0-1a2b-7c3d-8e4f-000000000707';

const MINUTE = 60 * 1000;

const macro = (overrides: Partial<Macro> & Pick<Macro, 'id' | 'name' | 'kind'>): Macro => ({
  scope: 'shared',
  departmentId: null,
  bodies: { en: '', ar: '' },
  actions: [],
  lastUsedAt: null,
  updatedAt: '2026-09-24T10:12:00.000Z',
  updatedById: '0192c3f0-1a2b-7c3d-8e4f-00000000000b',
  canEdit: true,
  ...overrides,
});

const seed = (now: number): Macro[] => [
  macro({
    id: MOCK_MACRO_REFUND,
    kind: 'macro',
    name: 'Refund issued',
    departmentId: BILLING?.id ?? null,
    bodies: {
      en: 'Hi {{contact.first_name}},\n\nWe issued your refund for {{ticket.number}} today. Card refunds take 3 to 5 business days to appear on your statement.\n\n{{agent.first_name}}, {{brand.name}}',
      ar: 'مرحباً {{contact.first_name}}،\n\nأصدرنا المبلغ المسترد لطلبك {{ticket.number}} اليوم. تظهر المبالغ المستردة على البطاقة خلال 3 إلى 5 أيام عمل.\n\n{{agent.first_name}}، فريق {{brand.name}}',
    },
    actions: [
      { type: 'set_status', statusId: STATUS_AWAITING },
      { type: 'add_tag', tagId: TAG_REFUND },
      { type: 'assign', assignee: { kind: 'self' } },
    ],
    lastUsedAt: new Date(now - 12 * MINUTE).toISOString(),
  }),
  macro({
    id: MOCK_MACRO_SHIPPING,
    kind: 'canned',
    name: 'Shipping fees explained',
    bodies: {
      en: 'Hi {{contact.first_name}}, the charge you saw at delivery is the carrier’s customs fee, not a shipping fee from us.',
      ar: 'مرحباً {{contact.first_name}}، الرسوم التي رأيتها عند الاستلام هي رسوم جمركية تفرضها شركة الشحن، وليست رسوم شحن منّا.',
    },
    lastUsedAt: new Date(now - 60 * MINUTE).toISOString(),
  }),
  macro({
    id: '0192c3f0-1a2b-7c3d-8e4f-000000000703',
    kind: 'canned',
    name: 'Password reset steps',
    departmentId: SUPPORT?.id ?? null,
    bodies: {
      en: 'Hi {{contact.first_name}}, open the sign-in page and choose "Forgot password".',
      ar: 'مرحباً {{contact.first_name}}، افتح صفحة تسجيل الدخول واختر "نسيت كلمة المرور".',
    },
    lastUsedAt: new Date(now - 24 * 60 * MINUTE).toISOString(),
  }),
  macro({
    id: '0192c3f0-1a2b-7c3d-8e4f-000000000704',
    kind: 'macro',
    name: 'Hand to finance',
    departmentId: BILLING?.id ?? null,
    actions: [
      { type: 'set_priority', priority: 'high' },
      { type: 'assign', assignee: { kind: 'unassigned' } },
    ],
    lastUsedAt: new Date(now - 2 * 24 * 60 * MINUTE).toISOString(),
  }),
  macro({
    id: '0192c3f0-1a2b-7c3d-8e4f-000000000705',
    kind: 'canned',
    name: 'Ask for the order number',
    bodies: {
      en: 'Hi {{contact.first_name}}, could you send us your order number?',
      ar: 'مرحباً {{contact.first_name}}، هل يمكنك إرسال رقم طلبك؟',
    },
    lastUsedAt: new Date(now - 3 * 24 * 60 * MINUTE).toISOString(),
  }),
  macro({
    id: '0192c3f0-1a2b-7c3d-8e4f-000000000706',
    kind: 'macro',
    name: 'Close as duplicate',
    bodies: {
      en: 'Hi {{contact.first_name}}, we are following this up on your other ticket.',
      ar: 'مرحباً {{contact.first_name}}، نتابع هذا الطلب في تذكرتك الأخرى.',
    },
    actions: [
      { type: 'set_status', statusId: STATUS_CLOSED },
      { type: 'remove_tag', tagId: TAG_BUG },
    ],
  }),
  macro({
    id: MOCK_MACRO_PERSONAL,
    kind: 'canned',
    name: 'My follow-up line',
    scope: 'personal',
    bodies: { en: 'I will check back with you tomorrow.', ar: '' },
    updatedById: MOCK_SELF_ID,
    lastUsedAt: new Date(now - 30 * MINUTE).toISOString(),
  }),
];

export class MockMacros {
  #rows: Macro[];
  #next = 0;

  constructor(now: number = Date.now()) {
    this.#rows = seed(now);
  }

  list(query: MacroListQuery = {}): MacroList {
    const q = query.q?.trim().toLowerCase() ?? '';

    return {
      macros: this.#rows
        .filter((row) => query.kind === undefined || row.kind === query.kind)
        .filter(
          (row) =>
            q === '' ||
            row.name.toLowerCase().includes(q) ||
            `${row.bodies.en} ${row.bodies.ar}`.toLowerCase().includes(q),
        )
        .filter(
          (row) =>
            query.departmentId === undefined ||
            row.scope === 'personal' ||
            row.departmentId === null ||
            row.departmentId === query.departmentId,
        )
        .sort((left, right) => left.name.localeCompare(right.name)),
    };
  }

  find(id: string): Macro | undefined {
    return this.#rows.find((row) => row.id === id);
  }

  create(request: MacroCreateRequest): Macro {
    const departmentId = request.scope === 'personal' ? null : request.departmentId;
    this.#assertShape({ ...request, departmentId });
    this.#next += 1;
    const created = macro({
      ...request,
      id: `0192c3f0-1a2b-7c3d-8e4f-${String(900_000_000_000 + this.#next)}`,
      departmentId,
      updatedAt: new Date().toISOString(),
      updatedById: MOCK_SELF_ID,
    });
    this.#rows = [...this.#rows, created];

    return created;
  }

  update(id: string, request: MacroUpdateRequest): Macro {
    const current = this.#require(id);
    const scope = request.scope ?? current.scope;
    const next: Macro = {
      ...current,
      ...(request.name === undefined ? {} : { name: request.name }),
      ...(request.bodies === undefined ? {} : { bodies: request.bodies }),
      ...(request.actions === undefined ? {} : { actions: request.actions }),
      scope,
      departmentId:
        scope === 'personal' ? null : (request.departmentId ?? current.departmentId ?? null),
      updatedAt: new Date().toISOString(),
      updatedById: MOCK_SELF_ID,
    };
    this.#assertShape(next);
    this.#rows = this.#rows.map((row) => (row.id === id ? next : row));

    return next;
  }

  remove(id: string): void {
    this.#require(id);
    this.#rows = this.#rows.filter((row) => row.id !== id);
  }

  touch(id: string): void {
    this.#rows = this.#rows.map((row) =>
      row.id === id ? { ...row, lastUsedAt: new Date().toISOString() } : row,
    );
  }

  #require(id: string): Macro {
    const row = this.find(id);
    if (row === undefined) {
      throw new Error('No such macro or canned response');
    }

    return row;
  }

  #assertShape(shape: Parameters<typeof macroShapeProblem>[0]): void {
    const problem = macroShapeProblem(shape);
    if (problem !== null) {
      throw new Error(problem);
    }
  }
}
