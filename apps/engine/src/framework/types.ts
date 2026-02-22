import type { JsonObject, JsonValue } from '@moltgames/domain';
import type { MCPToolDefinition } from '@moltgames/mcp-protocol';

export interface Action {
  tool: string;
  request_id: string;
  args: JsonObject;
}

export interface ValidationResult {
  valid: boolean;
  error?: string;
  retryable?: boolean;
}

export interface ApplyActionResult<S> {
  state: S;
  result: JsonValue;
}

export interface TerminationResult {
  ended: boolean;
  winner?: string; // agentId or null for draw
  reason?: string;
}

export interface GamePlugin<S = unknown> {
  gameId: string;
  ruleVersion: string;
  initialize(seed: number): S;
  getTurn(state: S): number;
  getAvailableTools(state: S, phase: string): MCPToolDefinition[];
  validateAction(state: S, action: Action): ValidationResult;
  applyAction(state: S, action: Action): ApplyActionResult<S>;
  checkTermination(state: S): TerminationResult | null;
}
