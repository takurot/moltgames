import Ajv, { type ValidateFunction } from 'ajv';
import type { MCPToolDefinition } from '@moltgames/mcp-protocol';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

export interface ToolCallCandidate {
  tool: unknown;
  args: unknown;
}

export type ToolCallValidationResult =
  | {
      ok: true;
      tool: MCPToolDefinition;
    }
  | {
      ok: false;
      reason: string;
    };

export class ToolCallGuard {
  private readonly ajv: Ajv;
  private readonly validators = new Map<string, ValidateFunction>();

  constructor() {
    this.ajv = new Ajv({ strict: false, allErrors: true });
  }

  validate(params: {
    action: ToolCallCandidate;
    tools: MCPToolDefinition[];
  }): ToolCallValidationResult {
    const { action, tools } = params;

    if (typeof action.tool !== 'string' || action.tool.length === 0) {
      return {
        ok: false,
        reason: 'Planner returned an empty tool name.',
      };
    }

    const selectedTool = tools.find((tool) => tool.name === action.tool);
    if (!selectedTool) {
      const availableTools = tools.map((tool) => tool.name).join(', ');
      return {
        ok: false,
        reason: `The tool "${action.tool}" is not available. Please choose from: ${availableTools}`,
      };
    }

    if (!isRecord(action.args)) {
      return {
        ok: false,
        reason: `Invalid arguments for tool "${selectedTool.name}": expected a JSON object.`,
      };
    }

    const validate = this.getValidator(selectedTool);
    const isValid = validate(action.args);

    if (!isValid) {
      const errors = this.ajv.errorsText(validate.errors);
      return {
        ok: false,
        reason: `Invalid arguments for tool "${selectedTool.name}": ${errors}. Please correct the arguments according to the schema.`,
      };
    }

    return {
      ok: true,
      tool: selectedTool,
    };
  }

  private getValidator(tool: MCPToolDefinition): ValidateFunction {
    const cacheKey = JSON.stringify({
      name: tool.name,
      version: tool.version,
      inputSchema: tool.inputSchema,
    });
    const cached = this.validators.get(cacheKey);
    if (cached) {
      return cached;
    }

    const validator = this.ajv.compile(tool.inputSchema);
    this.validators.set(cacheKey, validator);
    return validator;
  }
}
