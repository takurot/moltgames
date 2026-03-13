import {
  assertRuleVersionCompatibility,
  type LoadedGameRule,
  type RuleCatalog,
} from '@moltgames/rules';

import { RedisManager } from '../state/redis-manager.js';

export interface RuleSnapshot {
  gameId: string;
  ruleId: string;
  ruleVersion: string;
}

export interface RuleAuditEntry {
  action: 'publish' | 'rollback';
  actor: string;
  reason?: string;
  at: string;
  from?: RuleSnapshot;
  to: RuleSnapshot;
}

export interface PublishRuleInput {
  gameId: string;
  ruleId: string;
  ruleVersion: string;
  actor: string;
  reason?: string;
}

export interface RollbackRuleInput {
  gameId: string;
  actor: string;
  reason?: string;
  targetRuleId?: string;
  targetRuleVersion?: string;
}

const snapshotsEqual = (left: RuleSnapshot, right: RuleSnapshot): boolean =>
  left.gameId === right.gameId &&
  left.ruleId === right.ruleId &&
  left.ruleVersion === right.ruleVersion;

const toSnapshot = (rule: LoadedGameRule): RuleSnapshot => ({
  gameId: rule.gameId,
  ruleId: rule.ruleId,
  ruleVersion: rule.ruleVersion,
});

export class RuleRegistry {
  constructor(
    private readonly redis: RedisManager,
    private readonly catalog: RuleCatalog,
  ) {}

  async initialize(): Promise<void> {
    for (const gameId of this.catalog.listGames()) {
      const activeSnapshot = await this.getActiveRuleSnapshot(gameId);
      if (activeSnapshot === null) {
        const latest = this.catalog.getLatestRule(gameId);
        if (!latest) {
          throw new Error(`No rules loaded for game: ${gameId}`);
        }

        await this.redis.setActiveRuleSnapshot(gameId, toSnapshot(latest));
        continue;
      }

      const activeRule = this.catalog.getRule(
        activeSnapshot.gameId,
        activeSnapshot.ruleId,
        activeSnapshot.ruleVersion,
      );
      if (!activeRule) {
        throw new Error(
          `Active rule snapshot is invalid for ${gameId}: ${activeSnapshot.ruleId}@${activeSnapshot.ruleVersion}`,
        );
      }
    }
  }

  async listActiveRules(): Promise<RuleSnapshot[]> {
    const snapshots: RuleSnapshot[] = [];

    for (const gameId of this.catalog.listGames()) {
      const activeRule = await this.getActiveRuleDefinition(gameId);
      if (activeRule) {
        snapshots.push(toSnapshot(activeRule));
      }
    }

    return snapshots;
  }

  async getActiveRuleDefinition(gameId: string): Promise<LoadedGameRule | null> {
    const snapshot = await this.getActiveRuleSnapshot(gameId);
    if (snapshot !== null) {
      return this.catalog.getRule(snapshot.gameId, snapshot.ruleId, snapshot.ruleVersion) ?? null;
    }

    return this.catalog.getLatestRule(gameId) ?? null;
  }

  async publishRule(input: PublishRuleInput): Promise<RuleAuditEntry> {
    const nextRule = this.catalog.getRule(input.gameId, input.ruleId, input.ruleVersion);
    if (!nextRule) {
      throw new Error(
        `Rule definition not found: ${input.gameId}/${input.ruleId}@${input.ruleVersion}`,
      );
    }

    const currentRule = await this.getActiveRuleDefinition(input.gameId);
    const auditEntries = await this.listAuditEntries(input.gameId);
    if (currentRule && auditEntries.length > 0) {
      assertRuleVersionCompatibility(currentRule, nextRule);
    }

    const nextSnapshot = toSnapshot(nextRule);
    await this.redis.setActiveRuleSnapshot(input.gameId, nextSnapshot);

    const entry: RuleAuditEntry = {
      action: 'publish',
      actor: input.actor,
      at: new Date().toISOString(),
      to: nextSnapshot,
    };

    if (input.reason !== undefined) {
      entry.reason = input.reason;
    }

    if (currentRule) {
      entry.from = toSnapshot(currentRule);
    }

    await this.redis.appendRuleAuditEntry(input.gameId, entry);

    return entry;
  }

  async rollbackRule(input: RollbackRuleInput): Promise<RuleAuditEntry> {
    const currentRule = await this.getActiveRuleDefinition(input.gameId);
    if (!currentRule) {
      throw new Error(`No active rule for game: ${input.gameId}`);
    }

    const currentSnapshot = toSnapshot(currentRule);
    const targetRule =
      input.targetRuleId && input.targetRuleVersion
        ? this.catalog.getRule(input.gameId, input.targetRuleId, input.targetRuleVersion)
        : await this.resolvePreviousRule(input.gameId, currentSnapshot);

    if (!targetRule) {
      throw new Error(`Rollback target not found for game: ${input.gameId}`);
    }

    const targetSnapshot = toSnapshot(targetRule);
    await this.redis.setActiveRuleSnapshot(input.gameId, targetSnapshot);

    const entry: RuleAuditEntry = {
      action: 'rollback',
      actor: input.actor,
      at: new Date().toISOString(),
      from: currentSnapshot,
      to: targetSnapshot,
    };

    if (input.reason !== undefined) {
      entry.reason = input.reason;
    }

    await this.redis.appendRuleAuditEntry(input.gameId, entry);

    return entry;
  }

  async listAuditEntries(gameId: string): Promise<RuleAuditEntry[]> {
    return this.redis.listRuleAuditEntries<RuleAuditEntry>(gameId);
  }

  private async getActiveRuleSnapshot(gameId: string): Promise<RuleSnapshot | null> {
    return this.redis.getActiveRuleSnapshot<RuleSnapshot>(gameId);
  }

  private async resolvePreviousRule(
    gameId: string,
    currentSnapshot: RuleSnapshot,
  ): Promise<LoadedGameRule | null> {
    const entries = await this.listAuditEntries(gameId);

    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const candidate = entries[index]?.to;
      if (!candidate || snapshotsEqual(candidate, currentSnapshot)) {
        continue;
      }

      const resolved = this.catalog.getRule(
        candidate.gameId,
        candidate.ruleId,
        candidate.ruleVersion,
      );
      if (resolved) {
        return resolved;
      }
    }

    return null;
  }
}
