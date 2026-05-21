/**
 * Greenware Embed v1 — Events API contract tests.
 *
 * Locks down the six CustomEvents the core embed emits on the form
 * element (greenware:submit, greenware:processing, greenware:wait,
 * greenware:action, greenware:error, greenware:expired, greenware:reset) plus their
 * detail shapes. These are the contract between the core and any UI
 * layer — the bundled default-UI script, a host page's listeners, or
 * a Path 1 React component.
 *
 * Strategy: load the embed IIFE into a vm sandbox with a stubbed
 * `fetch` we can drive deterministically, then assert which events
 * fire with which detail shapes.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as vm from "node:vm";

type CapturedEvent = { name: string; detail: Record<string, unknown>; cancelable: boolean };

interface StubForm {
  __greenwareAttached?: boolean;
  tagName: "FORM";
  attributes: Map<string, string>;
  parentNode: { insertBefore(node: StubElement, before: unknown): void; removeChild(node: StubElement): void };
  nextSibling: null;
  nextElementSibling: StubElement | null;
  hasAttribute(name: string): boolean;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  classList: { add: () => void; remove: () => void };
  style: Record<string, string>;
  // Form data + DOM stubs the embed touches.
  _values: Record<string, string>;
  _submitListeners: Array<(ev: { preventDefault: () => void }) => void>;
  _listeners: Record<string, Array<(ev: Record<string, unknown>) => void>>;
  _insertedNodes: StubElement[];
  // Event capture
  _captured: CapturedEvent[];
  reportValidity(): boolean;
  querySelector(sel: string): null;
  querySelectorAll(sel: string): unknown[];
  getBoundingClientRect(): { top: number; left: number; width: number; height: number };
  addEventListener(name: string, fn: (...args: unknown[]) => unknown, _capture?: boolean): void;
  dispatchEvent(ev: Record<string, unknown>): boolean;
}

interface StubElement {
  id: string;
  attributes: Map<string, string>;
  style: Record<string, string>;
  classList: { add: () => void; remove: () => void };
  textContent: string;
  parentNode: { removeChild(node: StubElement): void } | null;
  setAttribute(name: string, value: string): void;
  hasAttribute(name: string): boolean;
  appendChild(): void;
}

function buildForm(values: Record<string, string>, attrs: Record<string, string>): StubForm {
  const attributes = new Map<string, string>(Object.entries(attrs));
  const captured: CapturedEvent[] = [];
  const submitListeners: Array<(ev: { preventDefault: () => void }) => void> = [];
  const listeners: Record<string, Array<(ev: Record<string, unknown>) => void>> = {};
  const insertedNodes: StubElement[] = [];
  const form: StubForm = {
    tagName: "FORM",
    attributes,
    parentNode: {
      insertBefore(node) {
        node.parentNode = form.parentNode;
        insertedNodes.push(node);
        form.nextElementSibling = node;
      },
      removeChild(node) {
        const idx = insertedNodes.indexOf(node);
        if (idx !== -1) insertedNodes.splice(idx, 1);
        if (form.nextElementSibling === node) form.nextElementSibling = null;
        node.parentNode = null;
      },
    },
    nextSibling: null,
    nextElementSibling: null,
    style: {},
    classList: { add: () => {}, remove: () => {} },
    _values: values,
    _submitListeners: submitListeners,
    _listeners: listeners,
    _insertedNodes: insertedNodes,
    _captured: captured,
    hasAttribute(name) { return attributes.has(name); },
    getAttribute(name) { return attributes.has(name) ? (attributes.get(name) ?? null) : null; },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    removeAttribute(name) { attributes.delete(name); },
    reportValidity() { return true; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { top: 0, left: 0, width: 200, height: 100 }; },
    addEventListener(name, fn) {
      if (name === "submit") submitListeners.push(fn as (ev: { preventDefault: () => void }) => void);
      if (!listeners[name]) listeners[name] = [];
      listeners[name].push(fn as (ev: Record<string, unknown>) => void);
    },
    dispatchEvent(ev) {
      const e = ev as { type: string; detail?: Record<string, unknown>; cancelable?: boolean; defaultPrevented?: boolean };
      captured.push({
        name: e.type,
        detail: (e.detail ?? {}) as Record<string, unknown>,
        cancelable: !!e.cancelable,
      });
      for (const fn of listeners[e.type] ?? []) fn(ev);
      return true;
    },
  };
  return form;
}

function buildStubElement(): StubElement {
  const attributes = new Map<string, string>();
  return {
    id: "",
    attributes,
    style: {},
    classList: { add: () => {}, remove: () => {} },
    textContent: "",
    parentNode: null,
    setAttribute(name, value) { attributes.set(name, String(value)); },
    hasAttribute(name) { return attributes.has(name); },
    appendChild() {},
  };
}

interface SandboxResult {
  form: StubForm;
  triggerSubmit(): Promise<void>;
  fetchCalls: Array<{ url: string; init: { method?: string; headers?: Record<string, string>; body?: string } }>;
  // Configure the sequence of fetch responses (in order called).
  setFetchResponses(responses: Array<{ status: number; body: unknown }>): void;
  windowLocation: { href: string };
}

function loadEmbed(form: StubForm): SandboxResult {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const embedSource = readFileSync(path.join(here, "..", "public", "embed", "v1.js"), "utf8");

  const fetchCalls: Array<{ url: string; init: { method?: string; headers?: Record<string, string>; body?: string } }> = [];
  let queue: Array<{ status: number; body: unknown }> = [];

  const stubFetch = (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    fetchCalls.push({ url, init });
    const next = queue.shift();
    if (!next) {
      return Promise.resolve(new Response(JSON.stringify({ status: "pending" }), { status: 200 }));
    }
    return Promise.resolve(
      new Response(JSON.stringify(next.body), {
        status: next.status,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };

  const windowLocation = { href: "about:blank" };
  const stubDocument = {
    readyState: "complete",
    addEventListener: () => {},
    querySelectorAll: (sel: string) => {
      if (sel === "form[data-greenware-attach]") {
        return [form] as unknown as NodeListOf<Element>;
      }
      return [] as unknown as NodeListOf<Element>;
    },
    head: { insertBefore: () => {}, firstChild: null },
    getElementById: () => null,
    createElement: () => buildStubElement(),
    body: { appendChild: () => {} },
    documentElement: { appendChild: () => {} },
  };

  const sandbox: Record<string, unknown> = {
    window: {
      matchMedia: () => ({ matches: false }),
      location: windowLocation,
      pageYOffset: 0,
      pageXOffset: 0,
      scrollY: 0,
      scrollX: 0,
      innerWidth: 1024,
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    document: stubDocument,
    FormData: class { constructor(_form?: unknown) { void _form; } entries(): Iterator<[string, string]> { const v = Object.entries(form._values); let i = 0; return { next() { return i < v.length ? { value: v[i++], done: false as const } : { value: undefined as unknown as [string, string], done: true as const }; } }; } getAll(name: string): string[] { const v = form._values[name]; return v === undefined ? [] : [v]; } },
    File,
    Set,
    Map,
    URL,
    console: { log: () => {}, warn: () => {}, error: () => {} },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    requestAnimationFrame: (cb: FrameRequestCallback) => { cb(0); return 0; },
    Date,
    Object,
    Array,
    JSON,
    fetch: stubFetch,
    Response,
    Request,
    Headers,
    CustomEvent: class { type: string; detail: unknown; bubbles: boolean; cancelable: boolean; defaultPrevented = false; constructor(type: string, init: { detail?: unknown; bubbles?: boolean; cancelable?: boolean }) { this.type = type; this.detail = init?.detail; this.bubbles = !!init?.bubbles; this.cancelable = !!init?.cancelable; } preventDefault() { this.defaultPrevented = true; } },
  };

  const ctx = vm.createContext(sandbox);
  vm.runInContext(embedSource, ctx, { filename: "embed/v1.js" });

  return {
    form,
    fetchCalls,
    setFetchResponses(responses) { queue = responses.slice(); },
    triggerSubmit() {
      const ev = { preventDefault: vi.fn() };
      for (const fn of form._submitListeners) fn(ev);
      // Yield the microtask queue several times so chained .then()s settle.
      return new Promise<void>((resolve) => {
        const drain = (n: number) => {
          if (n <= 0) return resolve();
          setTimeout(() => drain(n - 1), 5);
        };
        drain(8);
      });
    },
    windowLocation,
  };
}

describe("greenware embed events API", () => {
  let sandbox: SandboxResult;
  let form: StubForm;

  beforeEach(() => {
    form = buildForm(
      { email: "alice@acme.com", company: "Acme" },
      {
        "data-greenware-attach": "",
        "data-greenware-endpoint": "https://my-server.test",
        "data-greenware-form-id": "demo",
      },
    );
    sandbox = loadEmbed(form);
  });

  afterEach(() => {
    // Reset the IIFE-load guard so a fresh load works for the next test.
    // (Tests share a Node module cache but each vm context is isolated;
    // the guard lives on the per-context window.)
  });

  it("emits greenware:submit BEFORE the network call (cancelable, with lead + formId)", async () => {
    sandbox.setFetchResponses([
      { status: 200, body: { session_id: "sess-1", read_token: "tok-1", expires_at: 0 } },
      { status: 200, body: { status: "ready", action: { type: "message", title: "Hi", body: "There" } } },
    ]);

    await sandbox.triggerSubmit();

    // The first event MUST be greenware:submit, fired before any
    // fetch call is made. Cancelable so host pages can take over.
    expect(form._captured[0].name).toBe("greenware:submit");
    expect(form._captured[0].cancelable).toBe(true);
    expect(form._captured[0].detail).toEqual({
      lead: { email: "alice@acme.com", company: "Acme" },
      formId: "demo",
    });
  });

  it("emits the full happy-path event sequence", async () => {
    sandbox.setFetchResponses([
      { status: 200, body: { session_id: "sess-1", read_token: "tok-1", expires_at: 0 } },
      { status: 200, body: { status: "ready", action: { type: "message", title: "Hi", body: "There" } } },
    ]);

    await sandbox.triggerSubmit();

    const names = form._captured.map((e) => e.name);
    expect(names).toEqual([
      "greenware:submit",
      "greenware:processing",
      "greenware:wait",
      "greenware:action",
    ]);

    // wait detail: { sessionId, readToken } — ready for host pages to
    // re-issue the long-poll themselves if they want.
    expect(form._captured[1].detail).toEqual({ formId: "demo" });
    expect(form._captured[1].cancelable).toBe(false);
    expect(form._captured[2].detail).toEqual({
      sessionId: "sess-1",
      readToken: "tok-1",
    });
    expect(form._captured[2].cancelable).toBe(false);

    // action detail: flat action object.
    expect(form._captured[3].detail).toMatchObject({
      type: "message", title: "Hi", body: "There",
    });
  });

  it("mounts the wait overlay inline so returned content stays in the form container", async () => {
    sandbox.setFetchResponses([
      { status: 200, body: { session_id: "sess-1", read_token: "tok-1", expires_at: 0 } },
      { status: 200, body: { status: "ready", action: { type: "message", title: "Hi", body: "There" } } },
    ]);

    await sandbox.triggerSubmit();

    expect(form.style.display).toBe("none");
    expect(form._insertedNodes).toHaveLength(1);
    const overlay = form._insertedNodes[0]!;
    expect(form.nextElementSibling).toBe(overlay);
    expect(overlay.style.position).toBe("relative");
    expect(overlay.style.width).toBe("100%");
    expect(overlay.style.minHeight).toBe("100px");
    expect(overlay.style.overflow).toBe("hidden");

    form.dispatchEvent({ type: "greenware:reset", detail: {}, cancelable: false });

    expect(form.style.display).toBe("");
    expect(form._insertedNodes).toHaveLength(0);
  });

  it("emits greenware:error with errorCode SUBMIT_REJECTED on a non-2xx /api/submit", async () => {
    sandbox.setFetchResponses([{
      status: 403,
      body: { error: "ORIGIN_NOT_ALLOWED", problem: "Origin not allowed.", fix: "Add to allowed_origins." },
    }]);
    await sandbox.triggerSubmit();
    const names = form._captured.map((e) => e.name);
    expect(names).toContain("greenware:error");
    const errEvt = form._captured.find((e) => e.name === "greenware:error");
    expect(errEvt?.detail.errorCode).toBe("SUBMIT_REJECTED");
    // problem / fix forwarded from the server body when present.
    expect(errEvt?.detail.problem).toBe("Origin not allowed.");
    expect(errEvt?.detail.fix).toBe("Add to allowed_origins.");
  });

  it("emits greenware:expired (NOT greenware:error) when polling returns 404", async () => {
    sandbox.setFetchResponses([
      { status: 200, body: { session_id: "sess-2", read_token: "tok-2" } },
      { status: 404, body: { error: "NOT_FOUND" } },
    ]);
    await sandbox.triggerSubmit();
    const names = form._captured.map((e) => e.name);
    expect(names).toContain("greenware:expired");
    // The expired path is its own event — host pages don't have to
    // pattern-match on errorCode === "SESSION_EXPIRED".
    const expiredEvt = form._captured.find((e) => e.name === "greenware:expired");
    expect(expiredEvt?.detail).toEqual({});
  });

  it("emits greenware:action with redirect type and a flat URL detail", async () => {
    sandbox.setFetchResponses([
      { status: 200, body: { session_id: "sess-3", read_token: "tok-3" } },
      { status: 200, body: { status: "ready", action: { type: "redirect", url: "https://cal.com/me/30min" } } },
    ]);
    await sandbox.triggerSubmit();
    const actionEvt = form._captured.find((e) => e.name === "greenware:action");
    expect(actionEvt?.detail).toEqual({ type: "redirect", url: "https://cal.com/me/30min" });
  });

  it("preventDefault on greenware:submit cancels the network call (host takeover)", async () => {
    // Wire a listener that cancels. The dispatchEvent stub doesn't
    // invoke listeners, so we simulate by patching the form's
    // captured-event handler to flip defaultPrevented before
    // dispatchEvent returns. Easier: monkey-patch dispatchEvent for
    // submit only.
    const orig = form.dispatchEvent.bind(form);
    form.dispatchEvent = function (ev: Record<string, unknown>) {
      const e = ev as { type: string; defaultPrevented?: boolean };
      if (e.type === "greenware:submit") {
        e.defaultPrevented = true;
      }
      return orig(ev);
    };

    sandbox.setFetchResponses([
      { status: 200, body: { session_id: "should-not-be-used", read_token: "x" } },
    ]);
    await sandbox.triggerSubmit();

    // No fetch should have been made — the host took over.
    expect(sandbox.fetchCalls.length).toBe(0);
    // Only the submit event was emitted.
    expect(form._captured.map((e) => e.name)).toEqual(["greenware:submit"]);
  });
});
