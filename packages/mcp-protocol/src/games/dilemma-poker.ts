import { JsonSchemaObject } from '../schema';

export const DILEMMA_POKER_NEGOTIATE_SCHEMA: JsonSchemaObject = {
  type: 'object',
  properties: {
    message: {
      type: 'string',
      minLength: 1,
      maxLength: 500,
      description: 'Message to send to the opponent during the negotiation phase.',
    },
  },
  required: ['message'],
  additionalProperties: false,
};

export const DILEMMA_POKER_COMMIT_ACTION_SCHEMA: JsonSchemaObject = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['cooperate', 'defect'],
      description: 'The final action to take for this round: cooperate or defect.',
    },
  },
  required: ['action'],
  additionalProperties: false,
};

export const DILEMMA_POKER_GET_STATUS_SCHEMA: JsonSchemaObject = {
  type: 'object',
  properties: {},
  additionalProperties: false,
  description: 'Gets your current status, including chip count and current round.',
};
