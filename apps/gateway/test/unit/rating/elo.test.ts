import { describe, expect, it } from 'vitest';

import { calculateEloRatings } from '../../../src/rating/elo.js';

describe('rating elo calculation', () => {
  it('updates equal ratings on a decisive result', () => {
    expect(
      calculateEloRatings({
        playerA: { rating: 1500, score: 1 },
        playerB: { rating: 1500, score: 0 },
        kFactor: 32,
      }),
    ).toEqual({
      playerA: 1516,
      playerB: 1484,
    });
  });

  it('keeps equal ratings unchanged on a draw', () => {
    expect(
      calculateEloRatings({
        playerA: { rating: 1500, score: 0.5 },
        playerB: { rating: 1500, score: 0.5 },
        kFactor: 32,
      }),
    ).toEqual({
      playerA: 1500,
      playerB: 1500,
    });
  });
});
