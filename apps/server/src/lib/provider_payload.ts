export type ProviderName = "typeform" | "tally" | "generic";

export interface ProviderSubmission {
  sessionId: string;
  readToken?: string;
  formId?: string;
  providerSubmissionId?: string;
  lead: Record<string, unknown>;
}

const SESSION_KEYS = ["greenware_session_id", "gw_session_id", "session_id"];
const READ_TOKEN_KEYS = ["greenware_read_token", "gw_read_token", "read_token"];
const FORM_ID_KEYS = ["greenware_form_id", "gw_form_id", "form_id"];

export class ProviderPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderPayloadError";
  }
}

export function parseProviderName(raw: string): ProviderName {
  const normalized = raw.trim().toLowerCase();
  if (normalized === "typeform" || normalized === "tally") return normalized;
  return "generic";
}

export function extractProviderSubmission(
  raw: unknown,
  provider: ProviderName,
): ProviderSubmission {
  if (!isRecord(raw)) {
    throw new ProviderPayloadError("Provider webhook body must be a JSON object.");
  }

  const hidden = collectHidden(raw);
  const sessionId = firstStringFrom(hidden, SESSION_KEYS) ?? deepFindString(raw, SESSION_KEYS);
  if (sessionId === undefined || sessionId.length === 0) {
    throw new ProviderPayloadError(
      "Provider webhook is missing greenware_session_id hidden field.",
    );
  }

  const readToken = firstStringFrom(hidden, READ_TOKEN_KEYS) ?? deepFindString(raw, READ_TOKEN_KEYS);
  const formId = firstStringFrom(hidden, FORM_ID_KEYS) ?? deepFindString(raw, FORM_ID_KEYS);

  switch (provider) {
    case "typeform":
      return {
        sessionId,
        readToken,
        formId,
        providerSubmissionId: typeformSubmissionId(raw),
        lead: typeformLead(raw),
      };
    case "tally":
      return {
        sessionId,
        readToken,
        formId,
        providerSubmissionId: tallySubmissionId(raw),
        lead: tallyLead(raw),
      };
    case "generic":
      return {
        sessionId,
        readToken,
        formId,
        providerSubmissionId: genericSubmissionId(raw),
        lead: genericLead(raw),
      };
  }
}

function typeformSubmissionId(raw: Record<string, unknown>): string | undefined {
  const formResponse = recordAt(raw, "form_response");
  return stringAt(formResponse, "token") ?? stringAt(raw, "event_id");
}

function typeformLead(raw: Record<string, unknown>): Record<string, unknown> {
  const formResponse = recordAt(raw, "form_response");
  const answers = arrayAt(formResponse, "answers");
  const lead: Record<string, unknown> = {};
  for (const answer of answers) {
    if (!isRecord(answer)) continue;
    const field = recordAt(answer, "field");
    const key = normalizeKey(stringAt(field, "ref") ?? stringAt(field, "title") ?? stringAt(field, "id"));
    if (key === undefined || isReservedKey(key)) continue;
    const value = valueFromTypeformAnswer(answer);
    if (value !== undefined) lead[key] = value;
  }
  return lead;
}

function valueFromTypeformAnswer(answer: Record<string, unknown>): unknown {
  const type = stringAt(answer, "type");
  if (type !== undefined && answer[type] !== undefined) {
    return normalizeAnswerValue(answer[type]);
  }
  for (const key of ["email", "text", "number", "boolean", "phone_number", "url", "date"]) {
    if (answer[key] !== undefined) return normalizeAnswerValue(answer[key]);
  }
  if (isRecord(answer.choice)) return stringAt(answer.choice, "label");
  if (isRecord(answer.choices)) {
    const labels = arrayAt(answer.choices, "labels").filter((item): item is string => typeof item === "string");
    if (labels.length > 0) return labels;
  }
  return undefined;
}

function tallySubmissionId(raw: Record<string, unknown>): string | undefined {
  const data = recordAt(raw, "data");
  return (
    stringAt(data, "responseId") ??
    stringAt(data, "submissionId") ??
    stringAt(raw, "responseId") ??
    stringAt(raw, "submissionId") ??
    stringAt(raw, "eventId")
  );
}

function tallyLead(raw: Record<string, unknown>): Record<string, unknown> {
  const data = recordAt(raw, "data");
  const fields = arrayAt(data, "fields").length > 0 ? arrayAt(data, "fields") : arrayAt(raw, "fields");
  const lead: Record<string, unknown> = {};
  for (const field of fields) {
    if (!isRecord(field)) continue;
    const key = keyFromTallyField(field);
    if (key === undefined || isReservedKey(key)) continue;
    const value = valueFromTallyField(field);
    if (value !== undefined) lead[key] = normalizeAnswerValue(value);
  }
  if (Object.keys(lead).length > 0) return lead;
  return genericLead(raw);
}

function genericSubmissionId(raw: Record<string, unknown>): string | undefined {
  return (
    stringAt(raw, "provider_submission_id") ??
    stringAt(raw, "submission_id") ??
    stringAt(raw, "response_id") ??
    stringAt(raw, "id")
  );
}

function genericLead(raw: Record<string, unknown>): Record<string, unknown> {
  const explicitLead = recordAt(raw, "lead");
  const input = explicitLead ?? raw;
  const lead: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const normalizedKey = normalizeKey(key);
    if (normalizedKey === undefined || isReservedKey(normalizedKey)) continue;
    if (value === undefined || typeof value === "function") continue;
    lead[normalizedKey] = normalizeAnswerValue(value);
  }
  return lead;
}

function collectHidden(raw: unknown): Record<string, unknown> {
  const hidden: Record<string, unknown> = {};

  function merge(value: unknown): void {
    if (!isRecord(value)) return;
    for (const [key, item] of Object.entries(value)) hidden[key] = item;
  }

  if (isRecord(raw)) {
    merge(raw.hidden);
    merge(raw.hidden_fields);
    merge(raw.hiddenFields);
    collectHiddenFromFields(arrayAt(raw, "fields"), hidden);
    const formResponse = recordAt(raw, "form_response");
    merge(formResponse?.hidden);
    const data = recordAt(raw, "data");
    merge(data?.hidden);
    merge(data?.hidden_fields);
    merge(data?.hiddenFields);
    collectHiddenFromFields(arrayAt(data, "fields"), hidden);
  }

  return hidden;
}

function collectHiddenFromFields(fields: unknown[], hidden: Record<string, unknown>): void {
  for (const field of fields) {
    if (!isRecord(field)) continue;
    const key = reservedKeyFromTallyField(field);
    if (key === undefined || !isReservedKey(key)) continue;
    const value = valueFromTallyField(field);
    if (typeof value === "string" && value.length > 0) hidden[key] = value;
  }
}

function keyFromTallyField(field: Record<string, unknown>): string | undefined {
  const internalKey = normalizeKey(stringAt(field, "key"));
  const readableKey =
    normalizeKey(stringAt(field, "label")) ??
    normalizeKey(stringAt(field, "title")) ??
    normalizeKey(stringAt(field, "name"));
  if (internalKey !== undefined && !internalKey.startsWith("question_")) {
    return internalKey;
  }
  return readableKey ?? internalKey;
}

function reservedKeyFromTallyField(field: Record<string, unknown>): string | undefined {
  const candidates = [
    stringAt(field, "key"),
    stringAt(field, "label"),
    stringAt(field, "title"),
    stringAt(field, "name"),
  ];
  for (const candidate of candidates) {
    const key = normalizeKey(candidate);
    if (key !== undefined && isReservedKey(key)) return key;
  }
  return undefined;
}

function valueFromTallyField(field: Record<string, unknown>): unknown {
  if (field.value !== undefined) return field.value;
  const answer = field.answer;
  if (isRecord(answer)) {
    if (answer.value !== undefined) return answer.value;
    if (answer.raw !== undefined) return answer.raw;
  }
  return answer;
}

function normalizeAnswerValue(value: unknown): unknown {
  if (isRecord(value)) {
    if (typeof value.label === "string") return value.label;
    if (Array.isArray(value.labels)) return value.labels.filter((item) => typeof item === "string");
  }
  return value;
}

function normalizeKey(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const key = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return key.length > 0 ? key : undefined;
}

function isReservedKey(key: string): boolean {
  return SESSION_KEYS.includes(key) || READ_TOKEN_KEYS.includes(key) || FORM_ID_KEYS.includes(key);
}

function firstStringFrom(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function deepFindString(raw: unknown, keys: readonly string[], seen = new Set<unknown>()): string | undefined {
  if (!isRecord(raw) && !Array.isArray(raw)) return undefined;
  if (seen.has(raw)) return undefined;
  seen.add(raw);

  if (isRecord(raw)) {
    for (const key of keys) {
      const value = raw[key];
      if (typeof value === "string" && value.length > 0) return value;
    }
    for (const value of Object.values(raw)) {
      const found = deepFindString(value, keys, seen);
      if (found !== undefined) return found;
    }
  } else {
    for (const value of raw) {
      const found = deepFindString(value, keys, seen);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function recordAt(record: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  const value = record?.[key];
  return isRecord(value) ? value : undefined;
}

function stringAt(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function arrayAt(record: Record<string, unknown> | undefined, key: string): unknown[] {
  const value = record?.[key];
  return Array.isArray(value) ? value : [];
}
