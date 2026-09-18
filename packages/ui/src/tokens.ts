import tokensJson from '../tokens.json' with { type: 'json' };
import type { DesignTokens } from './tokens.schema.js';

/**
 * The design tokens from `packages/ui/tokens.json`, the single source of truth
 * for DESIGN §2–§4. The annotation is the compile-time check: a token removed
 * from the JSON fails the build here, and `tokens.test.ts` re-validates the
 * file against the Zod schema and against the token list in DESIGN §2.2.
 */
export const tokens: DesignTokens = tokensJson;

export type {
  DesignTokens,
  ElevationLevel,
  NeutralRamp,
  NeutralStep,
  SemanticTokenName,
  SemanticTokens,
  StatusName,
  SurfaceTone,
  TealStep,
  ThemeMode,
  TypeStyle,
} from './tokens.schema.js';
export {
  designTokensSchema,
  ELEVATION_LEVELS,
  NEUTRAL_STEPS,
  SEMANTIC_TOKEN_NAMES,
  STATUS_NAMES,
  SURFACE_TONES,
  TEAL_STEPS,
  TYPE_STYLES,
} from './tokens.schema.js';
