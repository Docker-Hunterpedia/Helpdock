import type {
  RuleBuilderOptions,
  RuleCreateRequest,
  RuleKind,
  RuleRunQuery,
  RuleTestRunRequest,
  RuleTestRunResult,
  RuleUpdateRequest,
  WorkflowRule,
  WorkflowRuleList,
  WorkflowRunList,
} from '@helpdock/schemas';

/**
 * Everything `Admin/Automation` needs (M3-03 to M3-05), and nothing else.
 * `MockAutomationApi` is the fixture the unit tests and the mock Playwright
 * projects run against; `HttpAutomationApi` is the real service.
 *
 * A failure crosses as the same errors the other adapters throw — an
 * `AuthError` the screen turns into its one "something went wrong" sentence —
 * because nothing here is refused by a rule with a reason of its own: a rule
 * that names something that is gone is answered by the form, before it is sent.
 */
export interface AutomationApi {
  rules(brandId: string, kind?: RuleKind): Promise<WorkflowRuleList>;
  createRule(brandId: string, request: RuleCreateRequest): Promise<WorkflowRule>;
  updateRule(brandId: string, ruleId: string, request: RuleUpdateRequest): Promise<WorkflowRule>;
  setRuleEnabled(brandId: string, ruleId: string, enabled: boolean): Promise<WorkflowRule>;
  deleteRule(brandId: string, ruleId: string): Promise<void>;
  /** Every rule of one kind, in its new order. */
  reorderRules(
    brandId: string,
    kind: RuleKind,
    ruleIds: readonly string[],
  ): Promise<WorkflowRuleList>;
  runs(brandId: string, query: RuleRunQuery): Promise<WorkflowRunList>;
  options(brandId: string): Promise<RuleBuilderOptions>;
  /** Changes, sends and logs nothing. */
  testRun(brandId: string, request: RuleTestRunRequest): Promise<RuleTestRunResult>;
}

/** Every cache key the automation screens use. */
export const automationKeys = {
  all: (brandId: string) => ['automation', brandId] as const,
  rules: (brandId: string) => ['automation', brandId, 'rules'] as const,
  runs: (brandId: string, query: RuleRunQuery) => ['automation', brandId, 'runs', query] as const,
  options: (brandId: string) => ['automation', brandId, 'options'] as const,
};
