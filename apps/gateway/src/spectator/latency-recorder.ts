export interface SpectatorLatencySample {
  matchId: string;
  eventId: string;
  spectatorCount: number;
  latencyMs: number;
  fanOutDurationMs: number;
  targetLatencyMs: number;
  withinTarget: boolean;
  eventTimestamp: string;
  recordedAt: string;
}

export interface SpectatorLatencyRecorder {
  record(sample: SpectatorLatencySample): Promise<void> | void;
}

interface LoggerLike {
  info(msg: string): void;
  info(obj: object, msg?: string): void;
}

export class LoggingSpectatorLatencyRecorder implements SpectatorLatencyRecorder {
  constructor(private readonly log: LoggerLike) {}

  record(sample: SpectatorLatencySample): void {
    this.log.info(
      {
        metric: 'spectator_broadcast_latency_ms',
        matchId: sample.matchId,
        eventId: sample.eventId,
        spectatorCount: sample.spectatorCount,
        latencyMs: sample.latencyMs,
        fanOutDurationMs: sample.fanOutDurationMs,
        targetLatencyMs: sample.targetLatencyMs,
        withinTarget: sample.withinTarget,
        eventTimestamp: sample.eventTimestamp,
        recordedAt: sample.recordedAt,
      },
      'Recorded spectator broadcast latency',
    );
  }
}
