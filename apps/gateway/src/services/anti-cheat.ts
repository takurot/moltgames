import { createHash } from 'node:crypto';

import type { Redis } from 'ioredis';

const ACTION_STATE_KEY_PREFIX = 'anticheat:action-state:';

// ---------------------------------------------------------------------------
// AnomalousSpeedDetector
// ---------------------------------------------------------------------------

export interface SpeedCheckResult {
  flagged: boolean;
  reason?: string;
}

interface ActionState {
  lastTimestamp: number;
  streak: number; // number of consecutive rapid actions (including last)
}

/**
 * Detects agents submitting actions unusually fast (< thresholdMs between
 * consecutive actions).  State (last timestamp + running streak) is stored in
 * Redis per match+agent pair.
 *
 * A "slow" action (gap >= thresholdMs) resets the streak to 1.
 * When streak reaches consecutiveCount the call returns flagged=true.
 */
export class AnomalousSpeedDetector {
  readonly #redis: Redis;

  constructor(redis: Redis) {
    this.#redis = redis;
  }

  async checkAction(
    matchId: string,
    agentId: string,
    thresholdMs = 100,
    consecutiveCount = 3,
    nowMs: number = Date.now(),
  ): Promise<SpeedCheckResult> {
    const key = `${ACTION_STATE_KEY_PREFIX}${matchId}:${agentId}`;
    const raw = await this.#redis.get(key);

    let streak: number;

    if (raw === null) {
      // First action for this agent in this match
      streak = 1;
    } else {
      const state = JSON.parse(raw) as ActionState;
      const gap = nowMs - state.lastTimestamp;

      if (gap < thresholdMs) {
        // Rapid action — extend the streak
        streak = state.streak + 1;
      } else {
        // Slow action — reset streak
        streak = 1;
      }
    }

    const newState: ActionState = { lastTimestamp: nowMs, streak };
    // Keep state for 24 hours (matches should not last longer)
    await this.#redis.set(key, JSON.stringify(newState), 'EX', 86400);

    if (streak >= consecutiveCount) {
      return {
        flagged: true,
        reason: `Agent submitted ${consecutiveCount} consecutive actions faster than ${thresholdMs}ms`,
      };
    }

    return { flagged: false };
  }

  /** Remove all stored state for a match (call on match end). */
  async clearMatch(matchId: string): Promise<void> {
    const keys = await this.#redis.keys(`${ACTION_STATE_KEY_PREFIX}${matchId}:*`);
    if (keys.length > 0) {
      await this.#redis.del(...keys);
    }
  }
}

// ---------------------------------------------------------------------------
// SelfPlayDetector
// ---------------------------------------------------------------------------

export interface SelfPlayCheckResult {
  blocked: boolean;
  reason?: string;
}

export interface ActiveParticipant {
  uid: string;
  ip: string;
}

/**
 * Prevents the same user account or same client IP from occupying both sides
 * of a match (self-play / Sybil attack).
 *
 * Stateless — the caller supplies the current list of active participants.
 */
export class SelfPlayDetector {
  checkEnqueue(
    uid: string,
    ip: string,
    activeParticipants: readonly ActiveParticipant[],
  ): SelfPlayCheckResult {
    for (const participant of activeParticipants) {
      if (participant.uid === uid) {
        return {
          blocked: true,
          reason: `uid ${uid} is already a participant in this match`,
        };
      }

      if (ip.trim().length > 0 && participant.ip.trim().length > 0 && participant.ip === ip) {
        return {
          blocked: true,
          reason: `ip ${ip} is already participating in this match`,
        };
      }
    }

    return { blocked: false };
  }
}

// ---------------------------------------------------------------------------
// ReplayIntegrityChecker helpers
// ---------------------------------------------------------------------------

/**
 * Compute SHA-256( prevHash || actionData ) and return the hex digest.
 */
export function computeEventHash(prevHash: string, actionData: string): string {
  return createHash('sha256').update(prevHash).update(actionData).digest('hex');
}

export interface EventChainEntry {
  hash: string;
  actionData: string;
  prevHash: string;
}

export interface ChainVerificationResult {
  valid: boolean;
  firstInvalidIndex?: number;
}

/**
 * Walk the event chain and verify each entry's hash matches
 * SHA-256( entry.prevHash || entry.actionData ).
 */
export function verifyEventChain(events: readonly EventChainEntry[]): ChainVerificationResult {
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (event === undefined) continue;

    const previousEvent = i === 0 ? undefined : events[i - 1];
    if (previousEvent !== undefined && event.prevHash !== previousEvent.hash) {
      return { valid: false, firstInvalidIndex: i };
    }

    const expected = computeEventHash(event.prevHash, event.actionData);
    if (event.hash !== expected) {
      return { valid: false, firstInvalidIndex: i };
    }
  }

  return { valid: true };
}
