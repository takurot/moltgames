import { JsonSchemaObject } from '../schema.js';

export const BLUFF_DICE_GET_STATE_SCHEMA: JsonSchemaObject = {
  type: 'object',
  properties: {},
  additionalProperties: false,
  description: 'Get the current game state visible to you.',
};

export const BLUFF_DICE_PLACE_BET_SCHEMA: JsonSchemaObject = {
  type: 'object',
  properties: {
    amount: {
      type: 'integer',
      minimum: 1,
      description: 'Number of chips to bet this round (1 to min(yourChips, maxBet)).',
    },
  },
  required: ['amount'],
  additionalProperties: false,
};

export const BLUFF_DICE_MAKE_BID_SCHEMA: JsonSchemaObject = {
  type: 'object',
  properties: {
    count: {
      type: 'integer',
      minimum: 1,
      maximum: 10,
      description: 'How many dice of the given face value you claim exist across all dice.',
    },
    face: {
      type: 'integer',
      minimum: 1,
      maximum: 6,
      description: 'The face value (1-6) of the dice you are bidding on.',
    },
  },
  required: ['count', 'face'],
  additionalProperties: false,
};

export const BLUFF_DICE_CALL_BLUFF_SCHEMA: JsonSchemaObject = {
  type: 'object',
  properties: {},
  additionalProperties: false,
  description: 'Challenge the current bid. Triggers resolution and reveals all dice.',
};
