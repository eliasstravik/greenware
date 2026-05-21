/**
 * Greenware server session store tests.
 *
 * These tests describe the platform-neutral session behavior Railway needs:
 * short-lived session records, idempotent terminal transitions, redacted
 * session logs, and TTL expiry without any hosted storage binding.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MemorySessionStore,
  type SessionLogEntry,
  type SessionRecord,
} from "../src/lib/sessions";

const SESSION_A = "6f2a7cba-5f63-4cf5-9f14-41c4f9c5b84c";
const SESSION_B = "bbbbbbbb-5f63-4cf5-9f14-41c4f9c5b84c";
const SESSION_C = "cccccccc-5f63-4cf5-9f14-41c4f9c5b84c";
const READ_TOKEN_HASH = "a".repeat(64);
const ORIGIN = "https://example.com";

const NOW_UNIX = 1_780_000_000;
const TTL = 600;
const EXPIRES_AT = NOW_UNIX + TTL;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_UNIX * 1000);
});

function makeStore(): MemorySessionStore {
  return new MemorySessionStore();
}

async function writePending(
  store: MemorySessionStore,
  sessionId: string = SESSION_A,
  createdAtUnix: number = NOW_UNIX,
): Promise<void> {
  await store.writePending({
    sessionId,
    readTokenHash: READ_TOKEN_HASH,
    origin: ORIGIN,
    expiresAtUnix: createdAtUnix + TTL,
    ttlSeconds: TTL,
  });
}

describe("MemorySessionStore — writePending/read", () => {
  it("round-trips a pending session", async () => {
    const store = makeStore();
    await writePending(store);

    const got = await store.read(SESSION_A);
    expect(got).toEqual({
      session_id: SESSION_A,
      status: "pending",
      read_token_hash: READ_TOKEN_HASH,
      origin: ORIGIN,
      created_at_unix: NOW_UNIX,
      expires_at_unix: EXPIRES_AT,
    } satisfies SessionRecord);
  });

  it("throws if a session id is reused", async () => {
    const store = makeStore();
    await writePending(store);

    await expect(writePending(store)).rejects.toThrow(/already exists/);
  });

  it("throws on zero or negative ttlSeconds", async () => {
    const store = makeStore();

    await expect(
      store.writePending({
        sessionId: SESSION_A,
        readTokenHash: READ_TOKEN_HASH,
        origin: ORIGIN,
        expiresAtUnix: EXPIRES_AT,
        ttlSeconds: 0,
      }),
    ).rejects.toThrow(/ttlSeconds/);
  });

  it("returns null and removes the record after TTL expiry", async () => {
    const store = makeStore();
    await writePending(store);

    vi.setSystemTime((EXPIRES_AT + 1) * 1000);

    expect(await store.read(SESSION_A)).toBeNull();
    expect(await store.listRecent(10)).toEqual([]);
  });
});

describe("MemorySessionStore — transitionToTerminal", () => {
  it("flips pending to ready and records duration", async () => {
    const store = makeStore();
    await writePending(store);
    vi.setSystemTime((NOW_UNIX + 3) * 1000);

    const result = await store.transitionToTerminal({
      sessionId: SESSION_A,
      status: "ready",
      actionHash: "hash-1",
      actionPayload: { type: "redirect", url: "https://cal.com/demo" },
    });

    expect(result).toEqual({ kind: "transitioned", previousStatus: "pending" });
    const rec = await store.read(SESSION_A);
    expect(rec?.status).toBe("ready");
    expect(rec?.action_hash).toBe("hash-1");
    expect(rec?.action_payload).toEqual({
      type: "redirect",
      url: "https://cal.com/demo",
    });
    expect(rec?.duration_ms).toBe(3000);
  });

  it("returns not_found for a missing session", async () => {
    const store = makeStore();

    const result = await store.transitionToTerminal({
      sessionId: SESSION_A,
      status: "ready",
      actionHash: "hash-1",
      actionPayload: { type: "redirect", url: "https://x.example.com" },
    });

    expect(result).toEqual({ kind: "not_found" });
  });

  it("treats identical ready callbacks as idempotent duplicates", async () => {
    const store = makeStore();
    await writePending(store);
    await store.transitionToTerminal({
      sessionId: SESSION_A,
      status: "ready",
      actionHash: "hash-1",
      actionPayload: { type: "redirect", url: "https://cal.com/demo" },
    });

    const before = await store.read(SESSION_A);
    const dup = await store.transitionToTerminal({
      sessionId: SESSION_A,
      status: "ready",
      actionHash: "hash-1",
      actionPayload: { type: "redirect", url: "https://cal.com/demo" },
    });

    expect(dup).toEqual({ kind: "idempotent_duplicate", actionHash: "hash-1" });
    expect(await store.read(SESSION_A)).toEqual(before);
  });

  it("rejects divergent callbacks after a session is ready", async () => {
    const store = makeStore();
    await writePending(store);
    await store.transitionToTerminal({
      sessionId: SESSION_A,
      status: "ready",
      actionHash: "hash-1",
      actionPayload: { type: "redirect", url: "https://cal.com/first" },
    });

    const before = await store.read(SESSION_A);
    const conflict = await store.transitionToTerminal({
      sessionId: SESSION_A,
      status: "ready",
      actionHash: "hash-2",
      actionPayload: { type: "redirect", url: "https://cal.com/second" },
    });

    expect(conflict).toEqual({ kind: "conflict", previousActionHash: "hash-1" });
    expect(await store.read(SESSION_A)).toEqual(before);
  });

  it("returns not_pending for failed sessions without an action hash", async () => {
    const store = makeStore();
    await writePending(store);
    await store.transitionToTerminal({
      sessionId: SESSION_A,
      status: "failed",
      errorCode: "WEBHOOK_TIMEOUT",
    });

    const result = await store.transitionToTerminal({
      sessionId: SESSION_A,
      status: "failed",
      errorCode: "WEBHOOK_NON_2XX",
    });

    expect(result).toEqual({ kind: "not_pending", currentStatus: "failed" });
  });
});

describe("MemorySessionStore — listRecent", () => {
  it("returns recent redacted log entries newest-first", async () => {
    const store = makeStore();

    vi.setSystemTime(NOW_UNIX * 1000);
    await writePending(store, SESSION_A, NOW_UNIX);
    await store.transitionToTerminal({
      sessionId: SESSION_A,
      status: "ready",
      actionHash: "hA",
      actionPayload: { type: "redirect", url: "https://a.example.com" },
    });

    vi.setSystemTime((NOW_UNIX + 3700) * 1000);
    await writePending(store, SESSION_B, NOW_UNIX + 3700);
    await store.transitionToTerminal({
      sessionId: SESSION_B,
      status: "failed",
      errorCode: "WEBHOOK_TIMEOUT",
    });

    vi.setSystemTime((NOW_UNIX + 7400) * 1000);
    await writePending(store, SESSION_C, NOW_UNIX + 7400);
    await store.transitionToTerminal({
      sessionId: SESSION_C,
      status: "ready",
      actionHash: "hC",
      actionPayload: { type: "message", title: "Hi", body: "Body" },
    });

    const got = await store.listRecent(10);
    expect(got.map((entry) => entry.session_id)).toEqual([SESSION_C, SESSION_B, SESSION_A]);
    expect(got[0]?.action_type).toBe("message");
    expect(got[1]?.error_code).toBe("WEBHOOK_TIMEOUT");
  });

  it("respects limit and never leaks raw payload fields", async () => {
    const store = makeStore();
    await writePending(store, SESSION_A);
    await store.transitionToTerminal({
      sessionId: SESSION_A,
      status: "ready",
      actionHash: "hA",
      actionPayload: {
        type: "redirect",
        url: "https://a.example.com?email=victim@example.com",
      },
    });

    const got = await store.listRecent(1);
    expect(got).toHaveLength(1);
    const entry = got[0] as SessionLogEntry & Record<string, unknown>;
    expect(entry.session_id).toBe(SESSION_A);
    expect(entry.action_type).toBe("redirect");
    expect(entry.action_payload).toBeUndefined();
    expect(entry.read_token_hash).toBeUndefined();
    expect(entry.email).toBeUndefined();
  });
});
