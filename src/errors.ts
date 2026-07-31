/**
 * Error taxonomy — three layers of defense:
 *  1. TransientAPIError  -> retried with exponential backoff + jitter
 *  2. ToolError          -> returned to the model (is_error) so it self-corrects
 *  3. FatalError         -> surfaced to the user; checkpoints stay intact for /undo
 */

export class ForgeError extends Error {}

export class ToolError extends ForgeError {}

export class TransientAPIError extends ForgeError {
  constructor(message: string, public retryAfter?: number) {
    super(message);
  }
}

export class FatalError extends ForgeError {}

export class CancelledError extends ForgeError {
  constructor() { super("Task cancelled by user."); }
}

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  signal?: AbortSignal;
  onRetry?: (attempt: number, err: Error, delayMs: number) => void;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); reject(new CancelledError()); }, { once: true });
  });

/** Retry `fn` on TransientAPIError with exponential backoff + jitter; honors Retry-After. */
export async function withRetries<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const { maxAttempts = 5, baseDelayMs = 1500, maxDelayMs = 60_000, signal, onRetry } = opts;
  let lastErr: Error | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal?.aborted) throw new CancelledError();
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof TransientAPIError)) throw err;
      lastErr = err;
      if (attempt === maxAttempts) break;
      let delay = err.retryAfter != null
        ? err.retryAfter * 1000
        : Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      delay *= 0.8 + 0.4 * Math.random(); // jitter
      onRetry?.(attempt, err, delay);
      await sleep(delay, signal);
    }
  }
  throw new FatalError(`API request failed after ${maxAttempts} attempts: ${lastErr?.message}`);
}
