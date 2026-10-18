import { z } from 'zod';
import { ConnectorError } from './errors.js';
import { hashImportValue } from './hash.js';

export const importTokenCycleSchema = z
  .strictObject({
    anchor: z.string().regex(/^[0-9a-f]{64}$/),
    power: z
      .number()
      .int()
      .positive()
      .max(2 ** 52),
    distance: z
      .number()
      .int()
      .nonnegative()
      .max(2 ** 52 - 1),
  })
  .refine((state) => state.distance < state.power);
export type ImportTokenCycle = z.infer<typeof importTokenCycleSchema>;

export function initialImportTokenCycle(): ImportTokenCycle {
  return { anchor: hashImportValue(null), power: 1, distance: 0 };
}

/** Brent's cycle detector retains constant checkpoint space even for very long exports. */
export function advanceImportTokenCycle(raw: ImportTokenCycle, next: string): ImportTokenCycle {
  const state = importTokenCycleSchema.parse(raw);
  const hash = hashImportValue(z.string().min(1).max(4096).parse(next));
  if (hash === state.anchor) throw new ConnectorError('invalid-response');
  const distance = state.distance + 1;
  return distance === state.power
    ? importTokenCycleSchema.parse({ anchor: hash, power: state.power * 2, distance: 0 })
    : { ...state, distance };
}
