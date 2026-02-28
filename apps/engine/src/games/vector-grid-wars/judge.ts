import OpenAI from 'openai';
import type { VectorGridWarsState } from './index.js';

export interface JudgeResult {
    score1: number;
    score2: number;
    reasoning: string;
}

export class LLMJudge {
    private openai: OpenAI | null = null;
    private modelName: string;

    constructor(options?: { model?: string }) {
        this.modelName = options?.model || 'gpt-4o-mini';
        try {
            this.openai = new OpenAI();
        } catch {
            console.warn('Failed to initialize OpenAI client. Mock judge will be used if process calls evaluate().');
        }
    }

    async evaluateBoard(state: VectorGridWarsState): Promise<{ agent1Score: number; agent2Score: number; winner: string | null; reason: string }> {
        if (!this.openai) {
            return this.mockEvaluate(state);
        }

        try {
            // We run 2 parallel evaluations and average them as specified in the plan
            const [eval1, eval2] = await Promise.all([
                this.callLLM(state),
                this.callLLM(state)
            ]);

            const avgScore1 = (eval1.score1 + eval2.score1) / 2;
            const avgScore2 = (eval1.score2 + eval2.score2) / 2;

            let winner: string | null = null;
            if (avgScore1 > avgScore2) {
                winner = state.agent1Id;
            } else if (avgScore2 > avgScore1) {
                winner = state.agent2Id;
            }

            const reason = `[Evaluation 1]
Score: ${state.agent1Id}: ${eval1.score1}, ${state.agent2Id}: ${eval2.score2}
Reason: ${eval1.reasoning}

[Evaluation 2]
Score: ${state.agent1Id}: ${eval2.score1}, ${state.agent2Id}: ${eval2.score2}
Reason: ${eval2.reasoning}

[Final Result]
Average Score - ${state.agent1Id}: ${avgScore1}, ${state.agent2Id}: ${avgScore2}`;

            return {
                agent1Score: avgScore1,
                agent2Score: avgScore2,
                winner,
                reason
            };
        } catch (error) {
            console.error('LLM Judge evaluation failed:', error);
            return this.mockEvaluate(state);
        }
    }

    private async callLLM(state: VectorGridWarsState): Promise<JudgeResult> {
        const prompt = this.buildPrompt(state);

        const response = await this.openai!.chat.completions.create({
            model: this.modelName,
            messages: [{ role: 'system', content: prompt }],
            response_format: { type: 'json_object' },
            temperature: 0.1,
        });

        const content = response.choices[0]?.message?.content;
        if (!content) {
            throw new Error('No content returned from LLM');
        }

        const parsed = JSON.parse(content);
        return {
            score1: typeof parsed.score1 === 'number' ? parsed.score1 : 0,
            score2: typeof parsed.score2 === 'number' ? parsed.score2 : 0,
            reasoning: parsed.reasoning || '',
        };
    }

    private buildPrompt(state: VectorGridWarsState): string {
        const lines = [];
        lines.push('You are the judge of a strategic board game called Vector Grid Wars.');
        lines.push('The board is a 10x10 grid. Two players compete for territory control.');
        lines.push('Each player places or moves units on the board. Each unit has an associated "concept" (a semantic keyword or phrase).');
        lines.push('You must evaluate the final board state and assign a score (0 to 100) to each player.');
        lines.push('Evaluation Criteria:');
        lines.push('1. Territory Quantity: Consider the number of grid cells controlled by each player.');
        lines.push('2. Spatial Strategy: Consider the positional arrangement. Central control, choke points, and continuous lines are advantageous.');
        lines.push('3. Semantic Synergy & Conflict: Analyze the "concepts" of the units. If Player 1 has a "Water" concept adjacent to Player 2\'s "Fire" concept, Player 1 might have a tactical advantage in that local skirmish. Look for synergies within a player\'s own units and counters against the opponent.');
        lines.push('');
        lines.push(`Player 1: ${state.agent1Id}`);
        lines.push(`Player 2: ${state.agent2Id}`);
        lines.push('');
        lines.push('Board State:');

        let p1Units = 0;
        let p2Units = 0;

        for (let y = 0; y < 10; y++) {
            for (let x = 0; x < 10; x++) {
                const cell = state.grid[y]?.[x];
                if (!cell) continue;
                if (cell.owner) {
                    lines.push(`- Pos(${x}, ${y}) | Owner: ${cell.owner} | Concept: "${cell.concept}"`);
                    if (cell.owner === state.agent1Id) p1Units++;
                    if (cell.owner === state.agent2Id) p2Units++;
                }
            }
        }

        if (p1Units === 0 && p2Units === 0) {
            lines.push('(Board is empty)');
        }

        lines.push('');
        lines.push('Return the evaluation as a JSON object with strictly these keys:');
        lines.push('- "score1": (number 0-100) for Player 1');
        lines.push('- "score2": (number 0-100) for Player 2');
        lines.push('- "reasoning": (string) Brief explanation of your decision');

        return lines.join('\\n');
    }

    // Fallback / Test implementation
    private mockEvaluate(state: VectorGridWarsState): { agent1Score: number; agent2Score: number; winner: string | null; reason: string } {
        let p1Units = 0;
        let p2Units = 0;

        for (let y = 0; y < 10; y++) {
            for (let x = 0; x < 10; x++) {
                const cell = state.grid[y]?.[x];
                if (!cell) continue;
                if (cell.owner === state.agent1Id) p1Units++;
                if (cell.owner === state.agent2Id) p2Units++;
            }
        }

        const { agent1Id, agent2Id } = state;
        let winner: string | null = null;
        if (p1Units > p2Units) winner = agent1Id;
        if (p2Units > p1Units) winner = agent2Id;

        return {
            agent1Score: p1Units * 10,
            agent2Score: p2Units * 10,
            winner,
            reason: '[Mock Judge] Evaluation based purely on unit count fallback.'
        };
    }
}
