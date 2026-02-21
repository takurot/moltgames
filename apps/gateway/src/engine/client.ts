export interface EngineClientOptions {
  baseUrl: string;
}

enum CircuitState {
  CLOSED,
  OPEN,
  HALF_OPEN,
}

export class EngineClient {
  private baseUrl: string;

  // Circuit Breaker State
  private state: CircuitState = CircuitState.CLOSED;
  private lastFailureTime = 0;
  private readonly failureThreshold = 0.5; // 50%
  private readonly windowSize = 10; // Request window
  private readonly openTimeout = 10000; // 10 seconds

  // Request history for calculating rate (true = success, false = failure)
  private history: boolean[] = [];

  constructor(options: EngineClientOptions) {
    this.baseUrl = options.baseUrl;
  }

  async request(path: string, init?: RequestInit): Promise<Response> {
    if (this.state === CircuitState.OPEN) {
      if (Date.now() - this.lastFailureTime > this.openTimeout) {
        this.state = CircuitState.HALF_OPEN;
      } else {
        throw new Error('Service Unavailable (Circuit Open)');
      }
    }

    const url = new URL(path, this.baseUrl);

    let attempt = 0;
    const maxRetries = 2;

    while (attempt <= maxRetries) {
      try {
        const response = await fetch(url, init);

        if (response.ok || response.status < 500) {
          this.recordSuccess();
          return response;
        }

        // 5xx error
        if (attempt < maxRetries) {
          const delay = 200 * Math.pow(2, attempt);
          await new Promise((r) => setTimeout(r, delay));
          attempt++;
          continue;
        } else {
          this.recordFailure();
          return response;
        }
      } catch (err) {
        // Network error
        if (attempt < maxRetries) {
          const delay = 200 * Math.pow(2, attempt);
          await new Promise((r) => setTimeout(r, delay));
          attempt++;
          continue;
        } else {
          this.recordFailure();
          throw err;
        }
      }
    }

    throw new Error('Unreachable');
  }

  private recordSuccess() {
    if (this.state === CircuitState.HALF_OPEN) {
      this.state = CircuitState.CLOSED;
      this.history = []; // Reset history
    }
    this.updateHistory(true);
  }

  private recordFailure() {
    this.lastFailureTime = Date.now();
    if (this.state === CircuitState.HALF_OPEN) {
      this.state = CircuitState.OPEN;
      return;
    }

    this.updateHistory(false);

    // Check threshold
    if (this.history.length >= this.windowSize) {
      const failCount = this.history.filter((s) => !s).length;
      if (failCount / this.history.length >= this.failureThreshold) {
        this.state = CircuitState.OPEN;
      }
    }
  }

  private updateHistory(success: boolean) {
    this.history.push(success);
    if (this.history.length > this.windowSize) {
      this.history.shift();
    }
  }
}
