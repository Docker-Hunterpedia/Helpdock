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
import {
  ruleBuilderOptionsSchema,
  ruleTestRunResultSchema,
  workflowRuleListSchema,
  workflowRuleSchema,
  workflowRunListSchema,
} from '@helpdock/schemas';
import { HttpTransport } from '../auth/http-transport.js';
import type { AutomationApi } from './api.js';

/**
 * The real automation service. It shares its {@link HttpTransport} with the
 * other adapters, so there is one access token and one refresh in the app, and
 * every response is parsed through the schema the api declared it with.
 */
export class HttpAutomationApi implements AutomationApi {
  readonly #transport: HttpTransport;

  constructor(transport: HttpTransport = new HttpTransport()) {
    this.#transport = transport;
  }

  async rules(brandId: string, kind?: RuleKind): Promise<WorkflowRuleList> {
    const query = kind === undefined ? '' : `?kind=${kind}`;
    return workflowRuleListSchema.parse(
      await this.#transport.request('GET', `${this.#rules(brandId)}${query}`),
    );
  }

  async createRule(brandId: string, request: RuleCreateRequest): Promise<WorkflowRule> {
    return workflowRuleSchema.parse(
      await this.#transport.request('POST', this.#rules(brandId), request),
    );
  }

  async updateRule(
    brandId: string,
    ruleId: string,
    request: RuleUpdateRequest,
  ): Promise<WorkflowRule> {
    return workflowRuleSchema.parse(
      await this.#transport.request('PUT', this.#rule(brandId, ruleId), request),
    );
  }

  async setRuleEnabled(brandId: string, ruleId: string, enabled: boolean): Promise<WorkflowRule> {
    return workflowRuleSchema.parse(
      await this.#transport.request('PATCH', this.#rule(brandId, ruleId), { enabled }),
    );
  }

  async deleteRule(brandId: string, ruleId: string): Promise<void> {
    await this.#transport.request('DELETE', this.#rule(brandId, ruleId));
  }

  async reorderRules(
    brandId: string,
    kind: RuleKind,
    ruleIds: readonly string[],
  ): Promise<WorkflowRuleList> {
    return workflowRuleListSchema.parse(
      await this.#transport.request('POST', `${this.#rules(brandId)}/reorder`, {
        kind,
        ruleIds,
      }),
    );
  }

  async runs(brandId: string, query: RuleRunQuery): Promise<WorkflowRunList> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (typeof value === 'string' && value !== '') {
        params.set(key, value);
      }
    }
    const search = params.size === 0 ? '' : `?${params.toString()}`;
    return workflowRunListSchema.parse(
      await this.#transport.request('GET', `${this.#rules(brandId)}/runs${search}`),
    );
  }

  async options(brandId: string): Promise<RuleBuilderOptions> {
    return ruleBuilderOptionsSchema.parse(
      await this.#transport.request('GET', `${this.#rules(brandId)}/options`),
    );
  }

  async testRun(brandId: string, request: RuleTestRunRequest): Promise<RuleTestRunResult> {
    return ruleTestRunResultSchema.parse(
      await this.#transport.request('POST', `${this.#rules(brandId)}/test-run`, request),
    );
  }

  #rules(brandId: string): string {
    return `/brands/${encodeURIComponent(brandId)}/rules`;
  }

  #rule(brandId: string, ruleId: string): string {
    return `${this.#rules(brandId)}/${encodeURIComponent(ruleId)}`;
  }
}
