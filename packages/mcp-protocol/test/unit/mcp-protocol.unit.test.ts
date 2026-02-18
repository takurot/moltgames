import { describe, expect, it } from 'vitest';

import {
  MCP_PROTOCOL_PACKAGE_NAME,
  TOOL_CALL_ERROR_RESPONSE_JSON_SCHEMA,
  TOOL_CALL_REQUEST_JSON_SCHEMA,
  TOOL_CALL_SUCCESS_RESPONSE_JSON_SCHEMA,
  TOOLS_LIST_MESSAGE_JSON_SCHEMA,
  getProtocolMetadata,
  isToolCallResponse,
  isToolsListMessage,
  parseToolCallRequest,
} from '../../src/index.js';

describe('mcp-protocol package', () => {
  it('resolves protocol metadata', () => {
    expect(getProtocolMetadata()).toEqual({
      protocolPackage: '@moltgames/mcp-protocol',
      protocolVersion: '1.0.0',
    });
  });

  it('exports package name constant', () => {
    expect(MCP_PROTOCOL_PACKAGE_NAME).toBe('@moltgames/mcp-protocol');
  });

  it('parses valid tool call request', () => {
    expect(
      parseToolCallRequest({
        tool: 'move_agent',
        request_id: '4d6b5ab2-7d80-4b6a-b868-7da9a90be67e',
        args: {
          x: 3,
          y: 4,
        },
      }),
    ).toEqual({
      tool: 'move_agent',
      request_id: '4d6b5ab2-7d80-4b6a-b868-7da9a90be67e',
      args: {
        x: 3,
        y: 4,
      },
    });
  });

  it('rejects invalid tool call request', () => {
    expect(() =>
      parseToolCallRequest({
        tool: '',
        request_id: 'request-1',
        args: {},
      }),
    ).toThrowError('Invalid MCP tool call request');

    expect(() =>
      parseToolCallRequest({
        tool: 'move_agent',
        request_id: 'request-2',
        args: ['not-an-object'],
      }),
    ).toThrowError('Invalid MCP tool call request');
  });

  it('validates response payloads', () => {
    expect(
      isToolCallResponse({
        request_id: 'request-1',
        status: 'ok',
        result: {
          accepted: true,
        },
      }),
    ).toBe(true);

    expect(
      isToolCallResponse({
        request_id: 'request-2',
        status: 'error',
        error: {
          code: 'VALIDATION_ERROR',
          message: 'invalid move',
          retryable: true,
        },
      }),
    ).toBe(true);

    expect(
      isToolCallResponse({
        request_id: 'request-3',
        status: 'error',
        error: {
          code: 'UNLISTED_CODE',
          message: 'unknown',
          retryable: false,
        },
      }),
    ).toBe(false);
  });

  it('validates tools list messages', () => {
    expect(
      isToolsListMessage({
        type: 'tools/list',
        tools: [
          {
            name: 'move_agent',
            version: '1.0.0',
            description: 'Move actor on board',
            inputSchema: {
              type: 'object',
              required: ['x', 'y'],
            },
          },
        ],
      }),
    ).toBe(true);

    expect(
      isToolsListMessage({
        type: 'tools/list',
        tools: [
          {
            name: '',
            version: '1.0.0',
            description: 'broken',
            inputSchema: {
              type: 'object',
            },
          },
        ],
      }),
    ).toBe(false);
  });

  it('exports JSON schema definitions', () => {
    expect(TOOL_CALL_REQUEST_JSON_SCHEMA).toMatchObject({
      type: 'object',
      required: ['tool', 'request_id', 'args'],
    });
    expect(TOOL_CALL_SUCCESS_RESPONSE_JSON_SCHEMA).toMatchObject({
      type: 'object',
      required: ['request_id', 'status', 'result'],
    });
    expect(TOOL_CALL_ERROR_RESPONSE_JSON_SCHEMA).toMatchObject({
      type: 'object',
      required: ['request_id', 'status', 'error'],
    });
    expect(TOOLS_LIST_MESSAGE_JSON_SCHEMA).toMatchObject({
      type: 'object',
      required: ['type', 'tools'],
    });
  });
});
