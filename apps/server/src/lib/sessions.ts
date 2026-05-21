/**
 * Greenware server — session-state storage layer.
 *
 * Exposes a `SessionStore` interface so route handlers are decoupled from the
 * concrete storage backend. The Railway runtime uses `MemorySessionStore` to
 * keep the deployment database-free.
 *
 * Scope of this module: storage only — no HTTP, no signing, no protocol
 * parsing. A session record holds a parsed Protocol v1 action payload as
 * `unknown` (passed through intact); this module does not validate it.
 *
 * PII hygiene: `SessionRecord.action_payload` is passed through unchanged
 * because the browser poll needs it to render. `SessionLogEntry` is strictly
 * the 7 fields below — NEVER the form or callback payload. See E11 in the
 * design doc.
 */

// ---------------------------------------------------------------------------
// Public types.
// ---------------------------------------------------------------------------

/**
 * Session lifecycle states.
 *
 * `pending`  — created by `writePending`, awaiting an enrichment callback.
 * `ready`    — enrichment returned an action; browser polls this.
 * `failed`   — enrichment returned an error, timed out, or signature failed.
 * `expired`  — session TTL lapsed before a callback arrived (written only
 *              in response to explicit transitions; the in-memory TTL sweep
 *              also garbage-collects the raw record independently).
 */
export type SessionStatus = "pending" | "ready" | "failed" | "expired";

/**
 * Action type names shared with Protocol v1. Reflected in
 * `SessionLogEntry.action_type` for the admin viewer; kept as a string literal
 * union here to avoid importing from `protocol.ts` (storage is independent).
 */
export type ActionTypeName = "redirect" | "embed" | "message" | "reject";

/**
 * Full session record. Returned by `SessionStore.read`.
 *
 * `action_hash` and `action_payload` are set on a terminal `ready` transition
 * so the browser poll can render the action. `error_code` is set on a
 * terminal `failed` transition. `duration_ms` is the wall-clock time from
 * `created_at_unix` to the terminal transition.
 */
export interface SessionRecord {
  session_id: string;
  status: SessionStatus;
  read_token_hash: string;
  origin: string;
  created_at_unix: number;
  expires_at_unix: number;
  source_provider?: string;
  provider_submission_id?: string;
  form_id?: string;
  submitted_at_unix?: number;
  action_hash?: string;
  action_payload?: unknown;
  error_code?: string;
  duration_ms?: number;
}

/**
 * Redacted log entry surfaced by `/setup/sessions`. Strictly the 7 fields
 * below — never form or callback payloads, emails, or company names.
 */
export interface SessionLogEntry {
  session_id: string;
  status: SessionStatus;
  created_at_unix: number;
  duration_ms?: number;
  action_type?: ActionTypeName;
  origin: string;
  error_code?: string;
}

/**
 * Result of a `transitionToTerminal` call.
 *
 * `transitioned`         — state flipped from pending → terminal; caller
 *                          can respond 200.
 * `idempotent_duplicate` — identical callback (matching `actionHash`)
 *                          replayed against an already-terminal session;
 *                          caller should respond 200 and not re-process.
 * `conflict`             — different `actionHash` against an already-
 *                          terminal session; caller should respond 409 and
 *                          log. State is preserved.
 * `not_found`            — no session with this id.
 * `not_pending`          — session exists but is already terminal, and no
 *                          `actionHash` was supplied to compare against.
 */
export type TransitionResult =
  | { kind: "transitioned"; previousStatus: "pending" }
  | { kind: "idempotent_duplicate"; actionHash: string }
  | { kind: "conflict"; previousActionHash: string }
  | { kind: "not_found" }
  | { kind: "not_pending"; currentStatus: "ready" | "failed" | "expired" };

export type AttachSubmissionResult =
  | { kind: "attached" }
  | { kind: "duplicate" }
  | { kind: "not_found" }
  | { kind: "not_pending"; currentStatus: "ready" | "failed" | "expired" };

/** Parameters for `writePending`. */
export interface WritePendingParams {
  sessionId: string;
  readTokenHash: string;
  origin: string;
  provider?: string;
  formId?: string;
  /** Unix seconds. Stored on the record so readers can tell absolute expiry. */
  expiresAtUnix: number;
  /** Session lifetime in seconds. Must be positive. */
  ttlSeconds: number;
}

/** Parameters for `transitionToTerminal`. */
export interface TransitionToTerminalParams {
  sessionId: string;
  status: "ready" | "failed" | "expired";
  /** Required when `status === "ready"` for idempotency; optional otherwise. */
  actionHash?: string;
  /** Parsed Protocol v1 action payload. Required when `status === "ready"`. */
  actionPayload?: unknown;
  /** Set on `failed`. */
  errorCode?: string;
}

export interface AttachSubmissionParams {
  sessionId: string;
  provider: string;
  providerSubmissionId?: string;
  formId?: string;
  submittedAtUnix?: number;
}

/**
 * Storage primitive for session state. Routes depend on this interface.
 */
export interface SessionStore {
  /** Read a session by id. Returns `null` if not found. */
  read(sessionId: string): Promise<SessionRecord | null>;

  /**
   * Write a new pending session. Throws if a session with the same id
   * already exists — callers should treat this as a programming error
   * (session ids are UUIDv4 server-generated).
   */
  writePending(params: WritePendingParams): Promise<void>;

  /**
   * Mark a pending session as having received its form-provider submission.
   * This gives webhook ingest idempotency before dispatching enrichment.
   */
  attachSubmission(params: AttachSubmissionParams): Promise<AttachSubmissionResult>;

  /**
   * Atomically-as-possible flip a pending session to a terminal state.
   * See `TransitionResult` for the outcome taxonomy. Idempotent in the
   * caller's contract — see the class-level note on CAS limits.
   */
  transitionToTerminal(params: TransitionToTerminalParams): Promise<TransitionResult>;

  /**
   * List the most recent `limit` log entries, newest-first, across all
   * hourly buckets. Strictly redacted — never returns form or callback
   * payloads. Used by the header-authenticated `/setup/sessions` endpoint.
   */
  listRecent(limit: number): Promise<SessionLogEntry[]>;
}

/** Seconds in seven days — log TTL per E11. */
const LOG_TTL_SECONDS = 604_800;
/**
 * Whitelist of fields allowed in a `SessionLogEntry`. Used by `listRecent`
 * to defensively filter out malformed entries that include forbidden fields
 * (e.g. a form payload leaked in from an older version).
 */
const LOG_ENTRY_ALLOWED_FIELDS: ReadonlyArray<keyof SessionLogEntry> = [
  "session_id",
  "status",
  "created_at_unix",
  "duration_ms",
  "action_type",
  "origin",
  "error_code",
];

/**
 * Map a Protocol v1 action payload to its `type` discriminant if recognizable,
 * without importing the zod schema (keeps this module independent). Returns
 * `undefined` for anything that isn't a plain object with a known type —
 * callers use that to omit the field from the redacted log entry.
 */
function actionTypeOf(payload: unknown): ActionTypeName | undefined {
  if (payload === null || typeof payload !== "object") return undefined;
  const t = (payload as { type?: unknown }).type;
  if (t === "redirect" || t === "embed" || t === "message" || t === "reject") {
    return t;
  }
  return undefined;
}

/**
 * Shrink an arbitrary parsed JSON value to the allowed `SessionLogEntry`
 * shape. Defensive filter against malformed log entries that include fields
 * outside the whitelist. Returns `null` if the value
 * isn't a plain object or is missing the required identifying fields.
 */
function redactLogEntry(raw: unknown): SessionLogEntry | null {
  if (raw === null || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;

  // Required fields — bail if any is missing or wrong-typed.
  if (typeof obj["session_id"] !== "string") return null;
  const status = obj["status"];
  if (
    status !== "pending" &&
    status !== "ready" &&
    status !== "failed" &&
    status !== "expired"
  ) {
    return null;
  }
  if (typeof obj["created_at_unix"] !== "number") return null;
  if (typeof obj["origin"] !== "string") return null;

  const out: SessionLogEntry = {
    session_id: obj["session_id"] as string,
    status,
    created_at_unix: obj["created_at_unix"] as number,
    origin: obj["origin"] as string,
  };
  if (typeof obj["duration_ms"] === "number") {
    out.duration_ms = obj["duration_ms"];
  }
  const at = obj["action_type"];
  if (at === "redirect" || at === "embed" || at === "message" || at === "reject") {
    out.action_type = at;
  }
  if (typeof obj["error_code"] === "string") {
    out.error_code = obj["error_code"];
  }
  // Any field outside LOG_ENTRY_ALLOWED_FIELDS is silently dropped — this
  // is the defensive filter against forbidden fields leaking.
  void LOG_ENTRY_ALLOWED_FIELDS;
  return out;
}

type TimedRecord<T> = {
  value: T;
  expiresAtMs: number;
};

/**
 * Single-process in-memory implementation of `SessionStore`.
 *
 * The tradeoff is explicit: sessions are short-lived and will be lost on
 * restart or when the app is scaled horizontally. Greenware keeps the default
 * deployment database-free, so production should run as a single web process.
 */
export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, TimedRecord<SessionRecord>>();
  private readonly logs = new Map<string, TimedRecord<SessionLogEntry>>();

  async read(sessionId: string): Promise<SessionRecord | null> {
    const record = this.sessions.get(sessionId);
    if (record === undefined) return null;
    if (this.hasExpired(record)) {
      this.sessions.delete(sessionId);
      return null;
    }
    return clone(record.value);
  }

  async writePending(params: WritePendingParams): Promise<void> {
    const { sessionId, readTokenHash, origin, expiresAtUnix, ttlSeconds } = params;

    if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
      throw new Error(`writePending: ttlSeconds must be > 0 (got ${ttlSeconds})`);
    }

    const existing = this.sessions.get(sessionId);
    if (existing !== undefined && !this.hasExpired(existing)) {
      throw new Error(`writePending: session ${sessionId} already exists`);
    }
    if (existing !== undefined) {
      this.sessions.delete(sessionId);
    }

    const createdAtUnix = expiresAtUnix - ttlSeconds;
    const record: SessionRecord = {
      session_id: sessionId,
      status: "pending",
      read_token_hash: readTokenHash,
      origin,
      created_at_unix: createdAtUnix,
      expires_at_unix: expiresAtUnix,
      ...(params.provider !== undefined ? { source_provider: params.provider } : {}),
      ...(params.formId !== undefined ? { form_id: params.formId } : {}),
    };

    this.sessions.set(sessionId, {
      value: record,
      expiresAtMs: expiresAtUnix * 1000,
    });
  }

  async attachSubmission(params: AttachSubmissionParams): Promise<AttachSubmissionResult> {
    const existing = await this.read(params.sessionId);
    if (existing === null) return { kind: "not_found" };
    if (existing.status !== "pending") {
      return {
        kind: "not_pending",
        currentStatus: existing.status as "ready" | "failed" | "expired",
      };
    }
    if (existing.submitted_at_unix !== undefined) return { kind: "duplicate" };

    const updated: SessionRecord = {
      ...existing,
      source_provider: params.provider,
      ...(params.providerSubmissionId !== undefined
        ? { provider_submission_id: params.providerSubmissionId }
        : {}),
      ...(params.formId !== undefined ? { form_id: params.formId } : {}),
      submitted_at_unix: params.submittedAtUnix ?? Math.floor(Date.now() / 1000),
    };

    this.sessions.set(params.sessionId, {
      value: updated,
      expiresAtMs: existing.expires_at_unix * 1000,
    });

    return { kind: "attached" };
  }

  async transitionToTerminal(
    params: TransitionToTerminalParams,
  ): Promise<TransitionResult> {
    const { sessionId, status, actionHash, actionPayload, errorCode } = params;

    const existing = await this.read(sessionId);
    if (existing === null) {
      return { kind: "not_found" };
    }

    if (existing.status !== "pending") {
      if (actionHash !== undefined && existing.action_hash === actionHash) {
        return { kind: "idempotent_duplicate", actionHash };
      }
      if (actionHash !== undefined && existing.action_hash !== undefined) {
        return { kind: "conflict", previousActionHash: existing.action_hash };
      }
      return {
        kind: "not_pending",
        currentStatus: existing.status as "ready" | "failed" | "expired",
      };
    }

    const nowUnix = Math.floor(Date.now() / 1000);
    const durationMs = Math.max(0, (nowUnix - existing.created_at_unix) * 1000);
    const updated: SessionRecord = {
      ...existing,
      status,
      duration_ms: durationMs,
      ...(actionHash !== undefined ? { action_hash: actionHash } : {}),
      ...(actionPayload !== undefined ? { action_payload: actionPayload } : {}),
      ...(errorCode !== undefined ? { error_code: errorCode } : {}),
    };

    this.sessions.set(sessionId, {
      value: updated,
      expiresAtMs: existing.expires_at_unix * 1000,
    });

    const actionType = actionTypeOf(actionPayload);
    const logEntry: SessionLogEntry = {
      session_id: sessionId,
      status,
      created_at_unix: existing.created_at_unix,
      duration_ms: durationMs,
      origin: existing.origin,
      ...(actionType !== undefined ? { action_type: actionType } : {}),
      ...(errorCode !== undefined ? { error_code: errorCode } : {}),
    };

    this.logs.set(sessionId, {
      value: logEntry,
      expiresAtMs: Date.now() + LOG_TTL_SECONDS * 1000,
    });

    return { kind: "transitioned", previousStatus: "pending" };
  }

  async listRecent(limit: number): Promise<SessionLogEntry[]> {
    if (!Number.isFinite(limit) || limit <= 0) return [];

    this.purgeExpiredLogs();
    const entries: SessionLogEntry[] = [];
    for (const record of this.logs.values()) {
      const redacted = redactLogEntry(record.value);
      if (redacted !== null) entries.push(redacted);
    }

    entries.sort((a, b) => b.created_at_unix - a.created_at_unix);
    return entries.slice(0, limit).map((entry) => clone(entry));
  }

  private hasExpired(record: TimedRecord<unknown>): boolean {
    return Date.now() >= record.expiresAtMs;
  }

  private purgeExpiredLogs(): void {
    for (const [key, record] of this.logs.entries()) {
      if (this.hasExpired(record)) {
        this.logs.delete(key);
      }
    }
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
