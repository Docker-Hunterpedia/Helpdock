import type { BrandAiSettings, BrandAiSettingsUpdate } from '@helpdock/schemas';

/**
 * The whole Admin form `PUT …/ai/settings` takes, from what is stored, so a
 * card that changes one part of it (a guardrail, the budget, the model) sends
 * the rest unchanged.
 */
export const settingsUpdateOf = (settings: BrandAiSettings): BrandAiSettingsUpdate => ({
  providerId: settings.providerId,
  modelId: settings.modelId,
  piiRedaction: settings.piiRedaction,
  injectionFilter: settings.injectionFilter,
  budget: settings.budget,
});
