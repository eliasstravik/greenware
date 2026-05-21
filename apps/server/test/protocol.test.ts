/**
 * Greenware Protocol v1 — zod schema tests.
 *
 * Covers the happy path for every action type plus the refinement
 * boundary for XSS, URL-scheme enforcement, strict-mode unknown-field
 * rejection, and unknown action types.
 */

import { describe, it, expect } from "vitest";
import {
  Action,
  ActionEmbed,
  ActionMessage,
  ActionRedirect,
  ActionReject,
  CallbackPayload,
  ErrorPayload,
  ProtocolParseError,
  isSafeUrl,
  parseCallback,
} from "../src/lib/protocol";

const SESSION = "6f2a7cba-5f63-4cf5-9f14-41c4f9c5b84c";

// ---------------------------------------------------------------------------
// Happy paths — one test per action type.
// ---------------------------------------------------------------------------

describe("parseCallback — happy path for each action type", () => {
  it("parses a valid redirect action", () => {
    const out = parseCallback({
      session_id: SESSION,
      status: "ok",
      action: {
        type: "redirect",
        url: "https://cal.com/acme/enterprise",
      },
    });
    expect(out.action.type).toBe("redirect");
    if (out.action.type === "redirect") {
      expect(out.action.url).toBe("https://cal.com/acme/enterprise");
    }
  });

  it("parses a valid embed action with explicit mobile_behavior", () => {
    const out = parseCallback({
      session_id: SESSION,
      status: "ok",
      action: {
        type: "embed",
        provider: "cal",
        url: "https://cal.com/acme/enterprise",
        mobile_behavior: "iframe",
      },
    });
    expect(out.action.type).toBe("embed");
    if (out.action.type === "embed") {
      expect(out.action.provider).toBe("cal");
      expect(out.action.mobile_behavior).toBe("iframe");
    }
  });

  it("parses a valid message action with CTA", () => {
    const out = parseCallback({
      session_id: SESSION,
      status: "ok",
      action: {
        type: "message",
        title: "Thanks, we'll be in touch",
        body: "Our team reviews every request within one business day.",
        cta: {
          label: "Read the blog",
          url: "https://acme.com/blog",
        },
      },
    });
    expect(out.action.type).toBe("message");
    if (out.action.type === "message") {
      expect(out.action.cta?.url).toBe("https://acme.com/blog");
    }
  });

  it("parses a valid reject action (no alternative)", () => {
    const out = parseCallback({
      session_id: SESSION,
      status: "ok",
      action: {
        type: "reject",
        reason: "We focus on mid-market teams right now. Thanks for reaching out.",
      },
    });
    expect(out.action.type).toBe("reject");
    if (out.action.type === "reject") {
      expect(out.action.alternative).toBeUndefined();
    }
  });

  it("parses optional meta when present", () => {
    const out = parseCallback({
      session_id: SESSION,
      status: "ok",
      action: { type: "redirect", url: "https://cal.com/acme" },
      meta: {
        enriched_at: "2026-04-23T12:34:56Z",
        source: "clay",
      },
    });
    expect(out.meta?.source).toBe("clay");
  });
});

// ---------------------------------------------------------------------------
// Embed default mobile_behavior is set correctly when omitted.
// ---------------------------------------------------------------------------

describe("embed.mobile_behavior default", () => {
  it("defaults mobile_behavior to 'redirect' when omitted", () => {
    const out = parseCallback({
      session_id: SESSION,
      status: "ok",
      action: {
        type: "embed",
        provider: "calendly",
        url: "https://calendly.com/acme/30min",
      },
    });
    if (out.action.type === "embed") {
      expect(out.action.mobile_behavior).toBe("redirect");
    } else {
      throw new Error("expected embed action");
    }
  });

  it("accepts explicit 'iframe' mobile_behavior", () => {
    const out = ActionEmbed.parse({
      type: "embed",
      provider: "iframe",
      url: "https://widget.example.com/book",
      mobile_behavior: "iframe",
    });
    expect(out.mobile_behavior).toBe("iframe");
  });
});

// ---------------------------------------------------------------------------
// Reject with optional alternative.
// ---------------------------------------------------------------------------

describe("reject.alternative", () => {
  it("accepts a valid alternative off-ramp", () => {
    const out = ActionReject.parse({
      type: "reject",
      reason: "We're focused on mid-market teams right now.",
      alternative: {
        label: "Join our community Slack",
        url: "https://acme.com/community",
      },
    });
    expect(out.alternative?.label).toBe("Join our community Slack");
    expect(out.alternative?.url).toBe("https://acme.com/community");
  });
});

// ---------------------------------------------------------------------------
// XSS rejection at the zod boundary.
// ---------------------------------------------------------------------------

describe("XSS rejection in text fields", () => {
  it("rejects <script> in message.body", () => {
    expect(() =>
      parseCallback({
        session_id: SESSION,
        status: "ok",
        action: {
          type: "message",
          title: "Hi",
          body: "hello <script>alert(1)</script>",
        },
      }),
    ).toThrow(ProtocolParseError);
  });

  it("rejects <script> in message.title", () => {
    expect(() =>
      parseCallback({
        session_id: SESSION,
        status: "ok",
        action: {
          type: "message",
          title: "<script>alert(1)</script>",
          body: "hello",
        },
      }),
    ).toThrow(ProtocolParseError);
  });

  it("rejects <script> in reject.reason", () => {
    expect(() =>
      parseCallback({
        session_id: SESSION,
        status: "ok",
        action: {
          type: "reject",
          reason: "not a fit <script>steal()</script>",
        },
      }),
    ).toThrow(ProtocolParseError);
  });

  it("catches mixed-case <SCRIPT as well", () => {
    expect(() =>
      ActionMessage.parse({
        type: "message",
        title: "hi",
        body: "<SCRIPT>alert(1)</SCRIPT>",
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// URL scheme rejection — redirect + embed + CTA.
// ---------------------------------------------------------------------------

describe("URL scheme rejection", () => {
  it("rejects javascript: in redirect.url", () => {
    expect(() =>
      parseCallback({
        session_id: SESSION,
        status: "ok",
        action: {
          type: "redirect",
          url: "javascript:alert(1)",
        },
      }),
    ).toThrow(ProtocolParseError);
  });

  it("rejects javascript: in embed.url", () => {
    expect(() =>
      parseCallback({
        session_id: SESSION,
        status: "ok",
        action: {
          type: "embed",
          provider: "iframe",
          url: "javascript:alert(1)",
        },
      }),
    ).toThrow(ProtocolParseError);
  });

  it("rejects data:text/html,... in redirect.url", () => {
    expect(() =>
      parseCallback({
        session_id: SESSION,
        status: "ok",
        action: {
          type: "redirect",
          url: "data:text/html,<script>alert(1)</script>",
        },
      }),
    ).toThrow(ProtocolParseError);
  });

  it("rejects data:text/html,... in embed.url", () => {
    expect(() =>
      parseCallback({
        session_id: SESSION,
        status: "ok",
        action: {
          type: "embed",
          provider: "iframe",
          url: "data:text/html,<script>alert(1)</script>",
        },
      }),
    ).toThrow(ProtocolParseError);
  });

  it("rejects vbscript: in CTA url", () => {
    expect(() =>
      ActionMessage.parse({
        type: "message",
        title: "hi",
        body: "body",
        cta: { label: "go", url: "vbscript:msgbox('x')" },
      }),
    ).toThrow();
  });

  it("rejects plain http:// in redirect.url (https-only)", () => {
    expect(() =>
      parseCallback({
        session_id: SESSION,
        status: "ok",
        action: {
          type: "redirect",
          url: "http://acme.com/",
        },
      }),
    ).toThrow(ProtocolParseError);
  });

  it("rejects file:// in redirect.url", () => {
    expect(() =>
      parseCallback({
        session_id: SESSION,
        status: "ok",
        action: {
          type: "redirect",
          url: "file:///etc/passwd",
        },
      }),
    ).toThrow(ProtocolParseError);
  });
});

// ---------------------------------------------------------------------------
// Discriminated-union rejection.
// ---------------------------------------------------------------------------

describe("unknown action types", () => {
  it("rejects unknown action.type with UNKNOWN_ACTION_TYPE code", () => {
    try {
      parseCallback({
        session_id: SESSION,
        status: "ok",
        action: {
          type: "replace_form", // v2 shape — not valid v1
          html: "<form></form>",
        },
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ProtocolParseError);
      expect((err as ProtocolParseError).code).toBe("UNKNOWN_ACTION_TYPE");
    }
  });

  it("discriminated union itself rejects unknown type", () => {
    expect(() =>
      Action.parse({ type: "nope", foo: 1 }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Missing required fields.
// ---------------------------------------------------------------------------

describe("missing required fields", () => {
  it("rejects missing session_id", () => {
    expect(() =>
      parseCallback({
        status: "ok",
        action: { type: "redirect", url: "https://cal.com/acme" },
      }),
    ).toThrow(ProtocolParseError);
  });

  it("rejects missing action", () => {
    expect(() =>
      parseCallback({
        session_id: SESSION,
        status: "ok",
      }),
    ).toThrow(ProtocolParseError);
  });

  it("rejects missing status", () => {
    expect(() =>
      parseCallback({
        session_id: SESSION,
        action: { type: "redirect", url: "https://cal.com/acme" },
      }),
    ).toThrow(ProtocolParseError);
  });

  it("rejects missing redirect.url", () => {
    expect(() =>
      parseCallback({
        session_id: SESSION,
        status: "ok",
        action: { type: "redirect" },
      }),
    ).toThrow(ProtocolParseError);
  });

  it("rejects missing reject.reason", () => {
    expect(() =>
      parseCallback({
        session_id: SESSION,
        status: "ok",
        action: { type: "reject" },
      }),
    ).toThrow(ProtocolParseError);
  });

  it("rejects missing message.title + body", () => {
    expect(() =>
      parseCallback({
        session_id: SESSION,
        status: "ok",
        action: { type: "message" },
      }),
    ).toThrow(ProtocolParseError);
  });

  it("rejects non-UUID session_id", () => {
    expect(() =>
      parseCallback({
        session_id: "not-a-uuid",
        status: "ok",
        action: { type: "redirect", url: "https://cal.com/acme" },
      }),
    ).toThrow(ProtocolParseError);
  });
});

// ---------------------------------------------------------------------------
// Strict mode — extra unknown keys are rejected.
// ---------------------------------------------------------------------------

describe("strict mode rejects unknown fields", () => {
  it("rejects extra top-level field", () => {
    expect(() =>
      parseCallback({
        session_id: SESSION,
        status: "ok",
        action: { type: "redirect", url: "https://cal.com/acme" },
        extra_top: "nope",
      }),
    ).toThrow(ProtocolParseError);
  });

  it("rejects extra field on action", () => {
    expect(() =>
      parseCallback({
        session_id: SESSION,
        status: "ok",
        action: {
          type: "redirect",
          url: "https://cal.com/acme",
          extra: "oops",
        },
      }),
    ).toThrow(ProtocolParseError);
  });

  it("rejects extra field on cta", () => {
    expect(() =>
      ActionMessage.parse({
        type: "message",
        title: "hi",
        body: "body",
        cta: {
          label: "go",
          url: "https://acme.com",
          target: "_blank", // not in v1 spec
        },
      }),
    ).toThrow();
  });

  it("rejects extra field on meta", () => {
    expect(() =>
      parseCallback({
        session_id: SESSION,
        status: "ok",
        action: { type: "redirect", url: "https://cal.com/acme" },
        meta: {
          enriched_at: "2026-04-23T12:34:56Z",
          extra_meta: "oops",
        },
      }),
    ).toThrow(ProtocolParseError);
  });
});

// ---------------------------------------------------------------------------
// Individual action schemas — direct parse.
// ---------------------------------------------------------------------------

describe("individual action schemas", () => {
  it("ActionRedirect parses a valid payload", () => {
    expect(ActionRedirect.parse({
      type: "redirect",
      url: "https://acme.com/signup",
    })).toEqual({
      type: "redirect",
      url: "https://acme.com/signup",
    });
  });

  it("ActionEmbed applies default mobile_behavior", () => {
    const out = ActionEmbed.parse({
      type: "embed",
      provider: "cal",
      url: "https://cal.com/acme",
    });
    expect(out.mobile_behavior).toBe("redirect");
  });

  it("ActionMessage parses without cta", () => {
    const out = ActionMessage.parse({
      type: "message",
      title: "Hi",
      body: "Thanks.",
    });
    expect(out.cta).toBeUndefined();
  });

  it("ActionReject parses without alternative", () => {
    const out = ActionReject.parse({
      type: "reject",
      reason: "not a fit right now",
    });
    expect(out.alternative).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ErrorPayload shape.
// ---------------------------------------------------------------------------

describe("ErrorPayload", () => {
  it("parses a valid error payload", () => {
    const out = ErrorPayload.parse({
      session_id: SESSION,
      status: "error",
      error_code: "INVALID_CALLBACK_PAYLOAD",
      problem: "Clay posted a callback Greenware could not parse.",
      cause: "Missing required field 'action.type'",
      fix: "Wrap payload as { action: { type: \"message\", ... } }",
      docs: "https://greenware.dev/docs/protocol-v1#message",
    });
    expect(out.error_code).toBe("INVALID_CALLBACK_PAYLOAD");
  });

  it("rejects unknown error_code", () => {
    expect(() =>
      ErrorPayload.parse({
        session_id: SESSION,
        status: "error",
        error_code: "UNKNOWN_CODE_LOL",
      }),
    ).toThrow();
  });

  it("rejects http:// docs URL", () => {
    expect(() =>
      ErrorPayload.parse({
        session_id: SESSION,
        status: "error",
        error_code: "WEBHOOK_TIMEOUT",
        docs: "http://insecure.example.com/docs",
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// isSafeUrl helper.
// ---------------------------------------------------------------------------

describe("isSafeUrl helper", () => {
  it("accepts https URLs when allowedSchemes is ['https:']", () => {
    expect(isSafeUrl("https://example.com", ["https:"])).toBe(true);
  });

  it("rejects http URLs when allowedSchemes is ['https:']", () => {
    expect(isSafeUrl("http://example.com", ["https:"])).toBe(false);
  });

  it("rejects javascript: scheme", () => {
    expect(isSafeUrl("javascript:alert(1)", ["https:"])).toBe(false);
  });

  it("rejects data: scheme", () => {
    expect(isSafeUrl("data:text/html,<script>", ["https:"])).toBe(false);
  });

  it("rejects vbscript: scheme", () => {
    expect(isSafeUrl("vbscript:msgbox('x')", ["https:"])).toBe(false);
  });

  it("rejects file:// scheme", () => {
    expect(isSafeUrl("file:///etc/passwd", ["https:"])).toBe(false);
  });

  it("rejects a URL that contains an XSS substring even if scheme is https", () => {
    // A URL that URL-parses as https: but contains "javascript:" in fragment.
    expect(
      isSafeUrl("https://example.com/#javascript:alert(1)", ["https:"]),
    ).toBe(false);
  });

  it("rejects malformed URLs", () => {
    expect(isSafeUrl("not a url", ["https:"])).toBe(false);
    expect(isSafeUrl("", ["https:"])).toBe(false);
  });

  it("respects custom allowedSchemes (dev-mode http is opt-in)", () => {
    expect(isSafeUrl("http://localhost:8787", ["https:", "http:"])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CallbackPayload — status discriminator.
// ---------------------------------------------------------------------------

describe("CallbackPayload status discriminator", () => {
  it("rejects status: 'error' at the ok parser", () => {
    // parseCallback() is for status:"ok" only.
    expect(() =>
      parseCallback({
        session_id: SESSION,
        status: "error",
        error_code: "WEBHOOK_TIMEOUT",
      }),
    ).toThrow(ProtocolParseError);
  });

  it("accepts valid shape via CallbackPayload.parse directly", () => {
    const out = CallbackPayload.parse({
      session_id: SESSION,
      status: "ok",
      action: { type: "redirect", url: "https://cal.com/acme" },
    });
    expect(out.status).toBe("ok");
  });
});
