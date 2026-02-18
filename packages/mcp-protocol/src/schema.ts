import { COMMON_ERROR_CODES, type JsonValue } from '@moltgames/domain';

export interface JsonSchemaObject {
  readonly [key: string]: JsonValue;
}

export const MCP_TOOL_DEFINITION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'description', 'version', 'inputSchema'],
  properties: {
    name: { type: 'string', minLength: 1 },
    description: { type: 'string', minLength: 1 },
    version: { type: 'string', minLength: 1 },
    inputSchema: { type: 'object' },
  },
} as const satisfies JsonSchemaObject;

export const TOOLS_LIST_MESSAGE_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'tools'],
  properties: {
    type: { const: 'tools/list' },
    tools: {
      type: 'array',
      items: MCP_TOOL_DEFINITION_JSON_SCHEMA,
    },
  },
} as const satisfies JsonSchemaObject;

export const TOOLS_LIST_CHANGED_MESSAGE_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'tools'],
  properties: {
    type: { const: 'tools/list_changed' },
    tools: {
      type: 'array',
      items: MCP_TOOL_DEFINITION_JSON_SCHEMA,
    },
  },
} as const satisfies JsonSchemaObject;

export const TOOL_CALL_REQUEST_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['tool', 'request_id', 'args'],
  properties: {
    tool: { type: 'string', minLength: 1 },
    request_id: { type: 'string', minLength: 1 },
    args: { type: 'object' },
  },
} as const satisfies JsonSchemaObject;

export const TOOL_CALL_SUCCESS_RESPONSE_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['request_id', 'status', 'result'],
  properties: {
    request_id: { type: 'string', minLength: 1 },
    status: { const: 'ok' },
    result: {},
  },
} as const satisfies JsonSchemaObject;

export const TOOL_CALL_ERROR_RESPONSE_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['request_id', 'status', 'error'],
  properties: {
    request_id: { type: 'string', minLength: 1 },
    status: { const: 'error' },
    error: {
      type: 'object',
      additionalProperties: false,
      required: ['code', 'message', 'retryable'],
      properties: {
        code: {
          type: 'string',
          enum: [...COMMON_ERROR_CODES],
        },
        message: { type: 'string', minLength: 1 },
        retryable: { type: 'boolean' },
      },
    },
  },
} as const satisfies JsonSchemaObject;
