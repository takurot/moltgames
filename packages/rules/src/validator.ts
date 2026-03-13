import { ZodError } from 'zod';

import { GameRuleSchema, type GameRule } from './schema.js';

export function validateRuleDefinition(data: unknown): GameRule {
  return GameRuleSchema.parse(data);
}

export function tryValidateRuleDefinition(
  data: unknown,
): { success: true; data: GameRule } | { success: false; error: ZodError } {
  const result = GameRuleSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }

  return { success: false, error: result.error };
}
