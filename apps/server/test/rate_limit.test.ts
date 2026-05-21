import { describe, expect, it } from "vitest";
import { MemoryRateLimiter } from "../src/lib/rate_limit";

describe("MemoryRateLimiter", () => {
  it("allows up to the limit in a 60-second window, then returns retryAfter", async () => {
    const limiter = new MemoryRateLimiter();

    expect(await limiter.checkAndIncrement({ ip: "203.0.113.7", limit: 2, now: 120 })).toEqual({
      allowed: true,
      remaining: 1,
      retryAfter: 0,
    });
    expect(await limiter.checkAndIncrement({ ip: "203.0.113.7", limit: 2, now: 121 })).toEqual({
      allowed: true,
      remaining: 0,
      retryAfter: 0,
    });
    expect(await limiter.checkAndIncrement({ ip: "203.0.113.7", limit: 2, now: 122 })).toEqual({
      allowed: false,
      remaining: 0,
      retryAfter: 58,
    });
  });

  it("starts a fresh counter in the next window", async () => {
    const limiter = new MemoryRateLimiter();

    expect(await limiter.checkAndIncrement({ ip: "203.0.113.7", limit: 1, now: 119 })).toMatchObject({
      allowed: true,
    });
    expect(await limiter.checkAndIncrement({ ip: "203.0.113.7", limit: 1, now: 120 })).toEqual({
      allowed: true,
      remaining: 0,
      retryAfter: 0,
    });
  });
});
