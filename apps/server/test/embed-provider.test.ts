import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as vm from "node:vm";

type HiddenFields = {
  session_id: string;
  read_token: string;
  hidden_fields?: Record<string, string>;
};

let greenware: {
  startSession?: unknown;
  attachProvider?: unknown;
  waitForSession?: unknown;
  __internals?: {
    withProviderHiddenFields?: (url: string, session: HiddenFields) => string;
    looksLikeProviderSubmitMessage?: (data: unknown) => boolean;
    providerOwnsMessage?: (
      target: {
        __greenwareProviderFrame?: { contentWindow: unknown };
        __greenwareProviderOrigin?: string | null;
        getAttribute?: (name: string) => string | null;
        querySelector?: (selector: string) => unknown;
      },
      event: { source: unknown; origin: string },
    ) => boolean;
  };
};

beforeAll(() => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const embedPath = path.join(here, "..", "public", "embed", "v1.js");
  const embedSource = readFileSync(embedPath, "utf8");

  const stubDocument = {
    readyState: "complete",
    addEventListener: () => {},
    querySelectorAll: () => [] as unknown as NodeListOf<Element>,
    documentElement: { appendChild: () => {} },
    head: { insertBefore: () => {}, firstChild: null },
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
    location: { origin: "https://route.example.com", href: "https://route.example.com/" },
    addEventListener: () => {},
    removeEventListener: () => {},
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
    CustomEvent,
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

  const win = sandbox.window as { Greenware?: typeof greenware };
  if (!win.Greenware) throw new Error("embed did not expose window.Greenware");
  greenware = win.Greenware;
});

describe("provider embed API", () => {
  it("exposes provider session helpers", () => {
    expect(typeof greenware.startSession).toBe("function");
    expect(typeof greenware.attachProvider).toBe("function");
    expect(typeof greenware.waitForSession).toBe("function");
  });

  it("adds Greenware hidden fields to provider iframe URLs without dropping existing params", () => {
    const out = greenware.__internals!.withProviderHiddenFields!(
      "https://tally.so/embed/abc123?alignLeft=1",
      {
        session_id: "session-1",
        read_token: "read-1",
        hidden_fields: {
          greenware_session_id: "session-1",
          greenware_read_token: "read-1",
          greenware_form_id: "enterprise-demo",
        },
      },
    );

    expect(out).toBe(
      "https://tally.so/embed/abc123?alignLeft=1&greenware_session_id=session-1&greenware_read_token=read-1&greenware_form_id=enterprise-demo",
    );
  });

  it("recognizes Tally submit postMessages when Tally sends JSON as a string", () => {
    const message = JSON.stringify({
      event: "Tally.FormSubmitted",
      payload: {
        formId: "D4xj1E",
      },
    });

    expect(greenware.__internals!.looksLikeProviderSubmitMessage!(message)).toBe(true);
    expect(greenware.__internals!.looksLikeProviderSubmitMessage!("[iFrameResizerChild]Ready")).toBe(false);
  });

  it("accepts provider postMessages only from the registered iframe and origin", () => {
    const contentWindow = {};
    const otherWindow = {};
    const target = {
      __greenwareProviderFrame: { contentWindow },
      __greenwareProviderOrigin: "https://tally.so",
      getAttribute: () => null,
    };

    expect(
      greenware.__internals!.providerOwnsMessage!(target, {
        source: contentWindow,
        origin: "https://tally.so",
      }),
    ).toBe(true);
    expect(
      greenware.__internals!.providerOwnsMessage!(target, {
        source: otherWindow,
        origin: "https://tally.so",
      }),
    ).toBe(false);
    expect(
      greenware.__internals!.providerOwnsMessage!(target, {
        source: contentWindow,
        origin: "https://evil.example.com",
      }),
    ).toBe(false);
  });
});
