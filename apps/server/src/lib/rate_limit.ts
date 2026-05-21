/**
 * Greenware server — per-IP rate limiter.
 *
 * The default limiter is an in-process fixed-window counter. It is
 * intentionally small and matches the v0.1 abuse-control requirement.
 * Deployments that need exact global limits can replace this behind the
 * `RateLimiter` interface.
 */

const WINDOW_SECONDS = 60;

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfter: number;
}

export interface RateLimiter {
  checkAndIncrement(params: {
    ip: string;
    limit: number;
    now?: number;
  }): Promise<RateLimitResult>;
}

export function windowFor(nowUnix: number): number {
  return Math.floor(nowUnix / WINDOW_SECONDS);
}

function keyFor(window: number, ip: string): string {
  return `${window}:${ip}`;
}

export class MemoryRateLimiter implements RateLimiter {
  private readonly counts = new Map<string, number>();

  async checkAndIncrement(params: {
    ip: string;
    limit: number;
    now?: number;
  }): Promise<RateLimitResult> {
    const now = params.now ?? Math.floor(Date.now() / 1000);
    const window = windowFor(now);
    const key = keyFor(window, params.ip);
    const current = this.counts.get(key) ?? 0;

    this.deleteOldWindows(window);

    if (current >= params.limit) {
      const nextWindowStart = (window + 1) * WINDOW_SECONDS;
      return {
        allowed: false,
        remaining: 0,
        retryAfter: Math.max(1, nextWindowStart - now),
      };
    }

    const next = current + 1;
    this.counts.set(key, next);
    return {
      allowed: true,
      remaining: Math.max(0, params.limit - next),
      retryAfter: 0,
    };
  }

  private deleteOldWindows(currentWindow: number): void {
    for (const key of this.counts.keys()) {
      const window = Number.parseInt(key.split(":", 1)[0] ?? "", 10);
      if (Number.isFinite(window) && window < currentWindow) {
        this.counts.delete(key);
      }
    }
  }
}
