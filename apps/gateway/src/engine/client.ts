export interface EngineClientOptions {
  engineUrl: string;
  retryAttempts?: number;
  circuitBreakerThreshold?: number; // error rate (0-1)
  circuitBreakerResetTimeout?: number; // ms
}

export class EngineClient {
  readonly #engineUrl: string;
  readonly #retryAttempts: number;
  readonly #circuitBreakerThreshold: number;
  readonly #circuitBreakerResetTimeout: number;

  #failureCount = 0;
  #successCount = 0;
  #circuitOpen = false;
  #circuitOpenTime = 0;

  constructor(options: EngineClientOptions) {
    this.#engineUrl = options.engineUrl.replace(/\/$/, '');
    this.#retryAttempts = options.retryAttempts ?? 2;
    this.#circuitBreakerThreshold = options.circuitBreakerThreshold ?? 0.5;
    this.#circuitBreakerResetTimeout = options.circuitBreakerResetTimeout ?? 10000;
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    if (this.#isCircuitOpen()) {
      throw new Error('Service Unavailable (Circuit Open)');
    }

    let attempts = 0;
    while (attempts <= this.#retryAttempts) {
      try {
        const result = await this.#executeRequest<T>(path, body);
        this.#recordSuccess();
        return result;
      } catch (error: any) {
        attempts++;
        if (attempts > this.#retryAttempts || !this.#isRetryable(error)) {
          this.#recordFailure();
          throw error;
        }
        await this.#wait(attempts);
      }
    }
    throw new Error('Unreachable code');
  }

  async #executeRequest<T>(path: string, body: unknown): Promise<T> {
    const url = `${this.#engineUrl}${path}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      if (response.status >= 500) {
        throw new Error(`Engine error: ${response.status}`);
      }
      throw new Error(`Engine error: ${response.status}`);
    }

    try {
      return (await response.json()) as T;
    } catch {
      throw new Error('Invalid response from Engine');
    }
  }

  #isRetryable(error: any): boolean {
    if (error.message.includes('Engine error: 5')) return true;
    if (error.name === 'TypeError') return true; // network error
    return false;
  }

  #wait(attempt: number): Promise<void> {
    const ms = Math.min(100 * Math.pow(2, attempt - 1), 5000);
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  #isCircuitOpen(): boolean {
    if (!this.#circuitOpen) return false;
    const now = Date.now();
    if (now - this.#circuitOpenTime > this.#circuitBreakerResetTimeout) {
      this.#circuitOpen = false;
      this.#resetStats();
      return false;
    }
    return true;
  }

  #recordSuccess() {
    this.#successCount++;
    this.#checkCircuit();
  }

  #recordFailure() {
    this.#failureCount++;
    this.#checkCircuit();
  }

  #resetStats() {
    this.#failureCount = 0;
    this.#successCount = 0;
  }

  #checkCircuit() {
    const total = this.#failureCount + this.#successCount;
    if (total < 10) return;

    const rate = this.#failureCount / total;
    if (rate > this.#circuitBreakerThreshold) {
      this.#circuitOpen = true;
      this.#circuitOpenTime = Date.now();
    }
  }
}
