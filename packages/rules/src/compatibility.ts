import { compareSemver, parseSemver, type GameRule } from './schema.js';
import { validateRuleDefinition } from './validator.js';

const stableSerialize = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableSerialize(entry)).join(',')}]`;
  }

  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    return `{${entries
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableSerialize(entryValue)}`)
      .join(',')}}`;
  }

  return JSON.stringify(value);
};

const getContractFingerprint = (rule: GameRule): string =>
  stableSerialize({
    gameId: rule.gameId,
    ruleId: rule.ruleId,
    tools: rule.tools,
    turnLimit: rule.turnLimit,
    termination: rule.termination,
    redactionPolicy: rule.redactionPolicy,
  });

export const hasBreakingContractChange = (previous: GameRule, next: GameRule): boolean =>
  getContractFingerprint(previous) !== getContractFingerprint(next);

export const assertRuleVersionCompatibility = (
  previousInput: unknown,
  nextInput: unknown,
): void => {
  const previous = validateRuleDefinition(previousInput);
  const next = validateRuleDefinition(nextInput);

  if (previous.gameId !== next.gameId || previous.ruleId !== next.ruleId) {
    throw new Error('Compatibility checks require matching gameId and ruleId');
  }

  if (compareSemver(next.ruleVersion, previous.ruleVersion) <= 0) {
    throw new Error('ruleVersion must move forward when publishing a new rule definition');
  }

  if (!hasBreakingContractChange(previous, next)) {
    return;
  }

  const previousMajor = parseSemver(previous.ruleVersion).major;
  const nextMajor = parseSemver(next.ruleVersion).major;
  if (nextMajor <= previousMajor) {
    throw new Error('Breaking contract changes require a major version bump');
  }
};
