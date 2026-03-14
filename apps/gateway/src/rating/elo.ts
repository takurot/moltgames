export interface EloParticipantInput {
  rating: number;
  score: number;
}

export interface CalculateEloRatingsInput {
  playerA: EloParticipantInput;
  playerB: EloParticipantInput;
  kFactor: number;
}

const expectedScore = (rating: number, opponentRating: number): number =>
  1 / (1 + 10 ** ((opponentRating - rating) / 400));

export const calculateEloRatings = (input: CalculateEloRatingsInput) => {
  const expectedA = expectedScore(input.playerA.rating, input.playerB.rating);
  const expectedB = expectedScore(input.playerB.rating, input.playerA.rating);

  return {
    playerA: Math.round(input.playerA.rating + input.kFactor * (input.playerA.score - expectedA)),
    playerB: Math.round(input.playerB.rating + input.kFactor * (input.playerB.score - expectedB)),
  };
};
