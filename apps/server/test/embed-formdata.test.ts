/**
 * Greenware Embed v1 — FormData extraction tests.
 *
 * Covers the `formDataToObject` helper inside `public/embed/v1.js`. The
 * helper is the workhorse for converting a browser FormData into the
 * plain `{name: value | string[]}` object that the embed sends to
 * `/api/submit`. v0.1 had a last-write-wins bug for repeat-key fields
 * (checkbox groups, multi-select); v0.2 fixes it and these tests guard
 * the new behavior.
 *
 * Strategy: the embed is an IIFE shipped as a static asset, not an ES
 * module. To keep one source of truth (no logic duplicated in the test)
 * we evaluate the embed source in a Node `vm` context with a minimal
 * stub `window`/`document`, then pull the helper off the
 * `window.Greenware.__internals` namespace it exposes.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as vm from "node:vm";

type FormDataValue = string | string[] | boolean;
type FormDataToObject = (fd: FormData) => Record<string, FormDataValue>;

let formDataToObject: FormDataToObject;

beforeAll(() => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const embedPath = path.join(here, "..", "public", "embed", "v1.js");
  const embedSource = readFileSync(embedPath, "utf8");

  // Minimal stub of the browser globals the embed touches at IIFE
  // import time. We DON'T need a full DOM — `install()` is the only
  // bit that walks the DOM, and it short-circuits cleanly when
  // `document.querySelectorAll` returns an empty NodeList. The IIFE
  // also reads `document.readyState` and may register a listener; we
  // satisfy both.
  const stubDocument = {
    readyState: "complete",
    addEventListener: () => {},
    querySelectorAll: () => [] as unknown as NodeListOf<Element>,
    head: {
      insertBefore: () => {},
      firstChild: null,
    },
    getElementById: () => null,
    createElement: () => ({
      id: "",
      setAttribute: () => {},
      appendChild: () => {},
      style: {},
      classList: { add: () => {}, remove: () => {} },
      textContent: "",
    }),
    body: { appendChild: () => {} },
  };

  const stubWindow: Record<string, unknown> = {
    matchMedia: () => ({ matches: false }),
    location: { origin: "https://test.local", href: "https://test.local/" },
    pageYOffset: 0,
    pageXOffset: 0,
    scrollY: 0,
    scrollX: 0,
    innerWidth: 1024,
  };

  const sandbox: Record<string, unknown> = {
    window: stubWindow,
    document: stubDocument,
    FormData,
    File,
    Set,
    Map,
    URL,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    requestAnimationFrame: (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    },
    Date,
    Object,
    Array,
    JSON,
    fetch: () => Promise.resolve(new Response("{}", { status: 200 })),
    Response,
    Request,
    Headers,
  };

  const ctx = vm.createContext(sandbox);
  vm.runInContext(embedSource, ctx, { filename: "embed/v1.js" });

  const win = sandbox.window as {
    Greenware?: { __internals?: { formDataToObject: FormDataToObject } };
  };
  if (!win.Greenware?.__internals?.formDataToObject) {
    throw new Error("embed did not expose Greenware.__internals.formDataToObject");
  }
  formDataToObject = win.Greenware.__internals.formDataToObject;
});

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe("formDataToObject", () => {
  it("returns a plain string for a single-valued field", () => {
    const fd = new FormData();
    fd.append("email", "alice@acme.com");
    expect(formDataToObject(fd)).toEqual({ email: "alice@acme.com" });
  });

  it("returns an array when the same name appears multiple times (checkbox group / multi-select)", () => {
    // Mirrors a <select multiple> or grouped checkboxes — name repeats,
    // each value distinct. v0.1 dropped all but the last; v0.2 keeps
    // them all in submission order.
    const fd = new FormData();
    fd.append("interests", "ai");
    fd.append("interests", "devtools");
    fd.append("interests", "ops");
    expect(formDataToObject(fd)).toEqual({
      interests: ["ai", "devtools", "ops"],
    });
  });

  it("filters out File entries even when string fields share the same name", () => {
    const fd = new FormData();
    fd.append("attachments", new File([], "resume.pdf", { type: "application/pdf" }));
    fd.append("attachments", "extra-text-note");
    fd.append("email", "bob@example.com");
    // The string survives, the File is dropped. Single survivor → string,
    // not single-element array.
    expect(formDataToObject(fd)).toEqual({
      attachments: "extra-text-note",
      email: "bob@example.com",
    });
  });

  it("drops a key entirely when ALL of its entries are File objects", () => {
    const fd = new FormData();
    fd.append("upload", new File([], "a.png"));
    fd.append("upload", new File([], "b.png"));
    fd.append("email", "carol@example.com");
    expect(formDataToObject(fd)).toEqual({ email: "carol@example.com" });
  });

  it("returns an empty object for an empty FormData", () => {
    const fd = new FormData();
    expect(formDataToObject(fd)).toEqual({});
  });

  it("preserves multi-value insertion order across mixed string + file entries", () => {
    // Defensive guard for a regression where filtering might reorder
    // the surviving entries.
    const fd = new FormData();
    fd.append("tags", "a");
    fd.append("tags", new File([], "ignored.txt"));
    fd.append("tags", "b");
    fd.append("tags", "c");
    expect(formDataToObject(fd)).toEqual({ tags: ["a", "b", "c"] });
  });
});
