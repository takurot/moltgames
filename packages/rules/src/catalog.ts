import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { compareSemver, type GameRule } from './schema.js';
import { validateRuleDefinition } from './validator.js';

export interface LoadRuleCatalogOptions {
  definitionsDir?: string;
}

const getDefaultDefinitionsDir = (): string =>
  fileURLToPath(new URL('../definitions', import.meta.url));

const sortRules = (left: GameRule, right: GameRule): number => {
  const byGame = left.gameId.localeCompare(right.gameId);
  if (byGame !== 0) {
    return byGame;
  }

  const byRule = left.ruleId.localeCompare(right.ruleId);
  if (byRule !== 0) {
    return byRule;
  }

  return compareSemver(left.ruleVersion, right.ruleVersion);
};

const parseScalar = (value: string): unknown => {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return '';
  }

  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  if (trimmed === 'true') {
    return true;
  }

  if (trimmed === 'false') {
    return false;
  }

  if (trimmed === 'null') {
    return null;
  }

  if (/^-?\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10);
  }

  if (/^-?\d+\.\d+$/.test(trimmed)) {
    return Number.parseFloat(trimmed);
  }

  return trimmed;
};

interface ParsedBlock {
  nextIndex: number;
  value: unknown;
}

const parseYaml = (input: string): unknown => {
  const lines = input
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line.trim().length > 0 && !line.trimStart().startsWith('#'));

  const getIndent = (line: string): number => line.length - line.trimStart().length;

  const parseObject = (
    startIndex: number,
    indent: number,
    seed: Record<string, unknown> = {},
  ): ParsedBlock => {
    const result: Record<string, unknown> = { ...seed };
    let index = startIndex;

    while (index < lines.length) {
      const line = lines[index]!;
      const lineIndent = getIndent(line);
      if (lineIndent < indent) {
        break;
      }
      if (lineIndent > indent) {
        throw new Error(`Unexpected indentation in YAML near "${line.trim()}"`);
      }

      const trimmed = line.trim();
      if (trimmed.startsWith('- ')) {
        break;
      }

      const separatorIndex = trimmed.indexOf(':');
      if (separatorIndex === -1) {
        throw new Error(`Invalid YAML mapping entry "${trimmed}"`);
      }

      const key = trimmed.slice(0, separatorIndex).trim();
      const remainder = trimmed.slice(separatorIndex + 1).trim();
      if (remainder.length > 0) {
        result[key] = parseScalar(remainder);
        index += 1;
        continue;
      }

      const nested = parseBlock(index + 1, indent + 2);
      result[key] = nested.value;
      index = nested.nextIndex;
    }

    return { nextIndex: index, value: result };
  };

  const parseArray = (startIndex: number, indent: number): ParsedBlock => {
    const result: unknown[] = [];
    let index = startIndex;

    while (index < lines.length) {
      const line = lines[index]!;
      const lineIndent = getIndent(line);
      if (lineIndent < indent) {
        break;
      }
      if (lineIndent > indent) {
        throw new Error(`Unexpected indentation in YAML near "${line.trim()}"`);
      }

      const trimmed = line.trim();
      if (!trimmed.startsWith('- ')) {
        break;
      }

      const remainder = trimmed.slice(2).trim();
      if (remainder.length === 0) {
        const nested = parseBlock(index + 1, indent + 2);
        result.push(nested.value);
        index = nested.nextIndex;
        continue;
      }

      const separatorIndex = remainder.indexOf(':');
      if (separatorIndex !== -1) {
        const key = remainder.slice(0, separatorIndex).trim();
        const valueText = remainder.slice(separatorIndex + 1).trim();
        const seed: Record<string, unknown> = {};
        if (valueText.length > 0) {
          seed[key] = parseScalar(valueText);
          const nested = parseObject(index + 1, indent + 2, seed);
          result.push(nested.value);
          index = nested.nextIndex;
          continue;
        }

        const nested = parseBlock(index + 1, indent + 4);
        seed[key] = nested.value;
        const merged = parseObject(nested.nextIndex, indent + 2, seed);
        result.push(merged.value);
        index = merged.nextIndex;
        continue;
      }

      result.push(parseScalar(remainder));
      index += 1;
    }

    return { nextIndex: index, value: result };
  };

  const parseBlock = (startIndex: number, indent: number): ParsedBlock => {
    if (startIndex >= lines.length) {
      throw new Error('Unexpected end of YAML document');
    }

    const line = lines[startIndex]!;
    const lineIndent = getIndent(line);
    if (lineIndent < indent) {
      throw new Error(`Expected indentation of at least ${indent} spaces`);
    }

    if (line.trim().startsWith('- ')) {
      return parseArray(startIndex, indent);
    }

    return parseObject(startIndex, indent);
  };

  if (lines.length === 0) {
    return {};
  }

  return parseBlock(0, 0).value;
};

const parseDefinitionFile = (filePath: string, fileContents: string): unknown => {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.json') {
    return JSON.parse(fileContents) as unknown;
  }

  if (extension === '.yaml' || extension === '.yml') {
    return parseYaml(fileContents);
  }

  throw new Error(`Unsupported rule definition format: ${path.basename(filePath)}`);
};

export class RuleCatalog {
  private readonly byGame = new Map<string, GameRule[]>();
  private readonly byCompositeKey = new Map<string, GameRule>();

  constructor(definitions: readonly GameRule[]) {
    if (definitions.length === 0) {
      throw new Error('No rule definitions were loaded');
    }

    const sortedDefinitions = [...definitions].sort(sortRules);
    for (const definition of sortedDefinitions) {
      const compositeKey = this.toCompositeKey(
        definition.gameId,
        definition.ruleId,
        definition.ruleVersion,
      );

      if (this.byCompositeKey.has(compositeKey)) {
        throw new Error(`Duplicate rule definition detected: ${compositeKey}`);
      }

      this.byCompositeKey.set(compositeKey, definition);

      const definitionsForGame = this.byGame.get(definition.gameId) ?? [];
      definitionsForGame.push(definition);
      this.byGame.set(definition.gameId, definitionsForGame);
    }
  }

  listRules(gameId?: string): GameRule[] {
    if (gameId !== undefined) {
      return [...(this.byGame.get(gameId) ?? [])];
    }

    return [...this.byCompositeKey.values()].sort(sortRules);
  }

  listGames(): string[] {
    return [...this.byGame.keys()].sort((left, right) => left.localeCompare(right));
  }

  getRule(gameId: string, ruleId: string, ruleVersion: string): GameRule | undefined {
    return this.byCompositeKey.get(this.toCompositeKey(gameId, ruleId, ruleVersion));
  }

  getLatestRule(gameId: string): GameRule | undefined {
    const definitions = this.byGame.get(gameId);
    if (!definitions || definitions.length === 0) {
      return undefined;
    }

    return [...definitions].sort((left, right) =>
      compareSemver(right.ruleVersion, left.ruleVersion),
    )[0];
  }

  private toCompositeKey(gameId: string, ruleId: string, ruleVersion: string): string {
    return `${gameId}:${ruleId}:${ruleVersion}`;
  }
}

export const loadRuleCatalog = async (
  options: LoadRuleCatalogOptions = {},
): Promise<RuleCatalog> => {
  const definitionsDir = options.definitionsDir ?? getDefaultDefinitionsDir();
  const entries = (await readdir(definitionsDir))
    .filter((entry) => {
      const extension = path.extname(entry).toLowerCase();
      return extension === '.json' || extension === '.yaml' || extension === '.yml';
    })
    .sort((left, right) => left.localeCompare(right));

  const definitions: GameRule[] = [];
  for (const entry of entries) {
    const fullPath = path.join(definitionsDir, entry);
    const contents = await readFile(fullPath, 'utf8');
    const parsed = parseDefinitionFile(fullPath, contents);
    definitions.push(validateRuleDefinition(parsed));
  }

  return new RuleCatalog(definitions);
};
