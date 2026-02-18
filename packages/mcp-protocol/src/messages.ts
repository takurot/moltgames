import {
  isCommonErrorCode,
  isJsonValue,
  isNonEmptyString,
  isRecord,
  type CommonErrorCode,
  type JsonObject,
  type JsonValue,
} from '@moltgames/domain';
import type { JsonSchemaObject } from './schema.js';

export const MCP_PROTOCOL_PACKAGE_NAME = '@moltgames/mcp-protocol';
export const MCP_PROTOCOL_VERSION = '1.0.0' as const;

export interface MCPToolDefinition {
  name: string;
  description: string;
  version: string;
  inputSchema: JsonSchemaObject;
}

export interface ToolsListMessage {
  type: 'tools/list';
  tools: MCPToolDefinition[];
}

export interface ToolsListChangedMessage {
  type: 'tools/list_changed';
  tools: MCPToolDefinition[];
}

export interface ToolCallRequest {
  tool: string;
  request_id: string;
  args: JsonObject;
}

export interface ToolCallSuccessResponse {
  request_id: string;
  status: 'ok';
  result: JsonValue;
}

export interface ToolCallErrorPayload {
  code: CommonErrorCode;
  message: string;
  retryable: boolean;
}

export interface ToolCallErrorResponse {
  request_id: string;
  status: 'error';
  error: ToolCallErrorPayload;
}

export type ToolCallResponse = ToolCallSuccessResponse | ToolCallErrorResponse;

const isJsonObject = (value: unknown): value is JsonObject => isRecord(value) && isJsonValue(value);

const isJsonSchemaObject = (value: unknown): value is JsonSchemaObject =>
  isRecord(value) && isJsonValue(value);

export const isMcpToolDefinition = (value: unknown): value is MCPToolDefinition => {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isNonEmptyString(value.name) &&
    isNonEmptyString(value.description) &&
    isNonEmptyString(value.version) &&
    isJsonSchemaObject(value.inputSchema)
  );
};

export const isToolsListMessage = (value: unknown): value is ToolsListMessage => {
  if (!isRecord(value)) {
    return false;
  }

  return (
    value.type === 'tools/list' &&
    Array.isArray(value.tools) &&
    value.tools.every((tool) => isMcpToolDefinition(tool))
  );
};

export const isToolsListChangedMessage = (value: unknown): value is ToolsListChangedMessage => {
  if (!isRecord(value)) {
    return false;
  }

  return (
    value.type === 'tools/list_changed' &&
    Array.isArray(value.tools) &&
    value.tools.every((tool) => isMcpToolDefinition(tool))
  );
};

export const isToolCallRequest = (value: unknown): value is ToolCallRequest => {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isNonEmptyString(value.tool) && isNonEmptyString(value.request_id) && isJsonObject(value.args)
  );
};

export const parseToolCallRequest = (value: unknown): ToolCallRequest => {
  if (!isToolCallRequest(value)) {
    throw new Error('Invalid MCP tool call request');
  }

  return value;
};

const isToolCallErrorPayload = (value: unknown): value is ToolCallErrorPayload => {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.code === 'string' &&
    isCommonErrorCode(value.code) &&
    isNonEmptyString(value.message) &&
    typeof value.retryable === 'boolean'
  );
};

export const isToolCallResponse = (value: unknown): value is ToolCallResponse => {
  if (!isRecord(value) || !isNonEmptyString(value.request_id)) {
    return false;
  }

  if (value.status === 'ok') {
    return isJsonValue(value.result);
  }

  if (value.status === 'error') {
    return isToolCallErrorPayload(value.error);
  }

  return false;
};

export const getProtocolMetadata = () => ({
  protocolPackage: MCP_PROTOCOL_PACKAGE_NAME,
  protocolVersion: MCP_PROTOCOL_VERSION,
});
