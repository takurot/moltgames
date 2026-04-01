import { z } from 'zod';
import type { JsonSchemaObject } from '@moltgames/mcp-protocol';

const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;

const jsonObjectSchema = z.record(z.string(), z.unknown()) as z.ZodType<JsonSchemaObject>;

export const RULE_SEMVER_SCHEMA = z
  .string()
  .regex(SEMVER_PATTERN, 'ruleVersion must be a SemVer string (x.y.z)');

export const RuleToolDefinitionSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().min(1),
    version: z.string().regex(SEMVER_PATTERN, 'tool version must be a SemVer string (x.y.z)'),
    inputSchema: jsonObjectSchema,
  })
  .strict();

export type RuleToolDefinition = z.infer<typeof RuleToolDefinitionSchema>;

export const GameRuleSchema = z
  .object({
    gameId: z.string().min(1),
    ruleId: z.string().min(1),
    ruleVersion: RULE_SEMVER_SCHEMA,
    turnLimit: z.number().int().positive(),
    turnTimeoutSeconds: z.number().int().positive().optional(),
    tools: z.array(RuleToolDefinitionSchema).min(1),
    parameters: jsonObjectSchema.default({}),
    termination: jsonObjectSchema,
    redactionPolicy: jsonObjectSchema,
  })
  .strict();

export type GameRule = z.infer<typeof GameRuleSchema>;
export type LoadedGameRule = GameRule;

export const PromptInjectionArenaParamsSchema = z
  .object({
    minimumDialogueRoundsForSecretGuess: z.number().int().nonnegative(),
    maxSecretGuessAttempts: z.number().int().positive(),
  })
  .strict();

export type PromptInjectionArenaParams = z.infer<typeof PromptInjectionArenaParamsSchema>;

export const VectorGridWarsParamsSchema = z
  .object({
    gridSize: z.number().int().positive().default(10),
  })
  .strict();

export type VectorGridWarsParams = z.infer<typeof VectorGridWarsParamsSchema>;

export const DilemmaPokerParamsSchema = z
  .object({
    initialChips: z.number().int().nonnegative(),
    maxRounds: z.number().int().positive(),
    negotiationPhaseMessagesPerRound: z.number().int().positive().default(2),
  })
  .strict();

export type DilemmaPokerParams = z.infer<typeof DilemmaPokerParamsSchema>;

export const BluffDiceParamsSchema = z
  .object({
    initialChips: z.number().int().positive().default(50),
    maxRounds: z.number().int().positive().default(5),
    diceCount: z.number().int().positive().default(5),
    maxBetPerRound: z.number().int().positive().default(10),
  })
  .strict();

export type BluffDiceParams = z.infer<typeof BluffDiceParamsSchema>;

export interface SemverParts {
  major: number;
  minor: number;
  patch: number;
}

export const parseSemver = (value: string): SemverParts => {
  const result = RULE_SEMVER_SCHEMA.safeParse(value);
  if (!result.success) {
    throw result.error;
  }

  const segments = result.data.split('.').map((segment) => Number.parseInt(segment, 10));
  if (segments.length !== 3 || segments.some((segment) => !Number.isInteger(segment))) {
    throw new Error(`Invalid semantic version: ${result.data}`);
  }

  const [major, minor, patch] = segments as [number, number, number];
  return { major, minor, patch };
};

export const compareSemver = (left: string, right: string): number => {
  const parsedLeft = parseSemver(left);
  const parsedRight = parseSemver(right);

  if (parsedLeft.major !== parsedRight.major) {
    return parsedLeft.major - parsedRight.major;
  }

  if (parsedLeft.minor !== parsedRight.minor) {
    return parsedLeft.minor - parsedRight.minor;
  }

  return parsedLeft.patch - parsedRight.patch;
};
