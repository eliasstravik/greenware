/*!
 * Greenware Embed v1 — Default UI layer.
 * https://greenware.dev
 *
 * The opinionated visual layer that subscribes to the events emitted
 * by `v1.js` (the core) and fills the core's overlay with Greenware's
 * default UI:
 *
 *   - Spinner card with rotating status messages.
 *   - Four action cards: redirect handoff, embed iframe (with mobile
 *     redirect fallback <768px), message card with optional CTA,
 *     reject card with optional alternative.
 *   - Generic error + expired states with a Try-again button that
 *     emits `greenware:reset` so the core can restore the form.
 *   - Brand colors, motion CSS, prefers-reduced-motion overrides.
 *
 * Independence:
 *   - Loads AFTER the core. If the core is missing, this script no-ops
 *     (registers listeners that never fire).
 *   - Cancels the core's default action behaviour (synchronous redirect)
 *     via `event.preventDefault()` so it can render the 600ms handoff
 *     card before navigating.
 *   - Owns nothing about the form lock or overlay positioning — those
 *     are the core's job. This layer only fills the overlay.
 *
 * No build step. No dependencies.
 */
(function () {
  "use strict";

  if (window.__greenwareDefaultUiV1Loaded) return;
  window.__greenwareDefaultUiV1Loaded = true;

  // -------------------------------------------------------------------------
  // Configuration + constants
  // -------------------------------------------------------------------------

  var DEFAULT_SPINNER_MESSAGES = [
    "Looking you up",
    "Matching you with the right path",
    "Just a moment",
    "Almost there"
  ];

  var SPINNER_ROTATE_MS = 3000;
  var SPINNER_CROSSFADE_MS = 500;
  var MOBILE_MAX_PX = 768;
  var ALLOWED_SCHEMES = ["https:"];
  var REDIRECT_HANDOFF_MS = 600;
  var EASE_OUT = "cubic-bezier(0.4, 0, 0.2, 1)";
  var EASE_SPRING = "cubic-bezier(0.25, 0.46, 0.45, 0.94)";
  var EASE_EXIT = "cubic-bezier(0.4, 0, 1, 1)";
  var VERSION = "1.0.0";

  var KNOWN_PROVIDERS = {
    "cal.com": "cal.com",
    "www.cal.com": "cal.com",
    "calendly.com": "calendly.com",
    "www.calendly.com": "calendly.com",
    "hubspot.com": "hubspot.com",
    "www.hubspot.com": "hubspot.com",
    "meetings.hubspot.com": "hubspot.com"
  };

  function prefersReducedMotion() {
    try {
      return typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch (_) { return false; }
  }

  function isSafeUrl(url) {
    if (typeof url !== "string" || url.length === 0) return false;
    try {
      return ALLOWED_SCHEMES.indexOf(new URL(url).protocol) !== -1;
    } catch (_) { return false; }
  }

  function hostnameOf(url) {
    try { return new URL(url).hostname; } catch (_) { return url; }
  }

  function providerDisplayName(url) {
    var h = hostnameOf(url).toLowerCase();
    var keys = Object.keys(KNOWN_PROVIDERS);
    for (var i = 0; i < keys.length; i++) {
      if (h === keys[i] || h.endsWith("." + keys[i])) return KNOWN_PROVIDERS[keys[i]];
    }
    return h;
  }

  function isMobileViewport() {
    return typeof window.innerWidth === "number" && window.innerWidth < MOBILE_MAX_PX;
  }

  function el(tag, attrs, text) {
    var node = document.createElement(tag);
    if (attrs) {
      for (var key in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, key)) continue;
        var value = attrs[key];
        if (value === null || value === undefined || value === false) continue;
        if (key === "className") node.className = value;
        else node.setAttribute(key, value === true ? "" : value);
      }
    }
    if (typeof text === "string" && text.length > 0) node.textContent = text;
    return node;
  }

  function appendBodyWithLineBreaks(parent, bodyText) {
    if (typeof bodyText !== "string") return;
    var lines = bodyText.split("\n");
    for (var i = 0; i < lines.length; i++) {
      if (i > 0) parent.appendChild(document.createElement("br"));
      parent.appendChild(document.createTextNode(lines[i]));
    }
  }

  function clearChildren(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  // -------------------------------------------------------------------------
  // Styles — injected once into <head>.
  // -------------------------------------------------------------------------

  var STYLES = [
    /* The core gives us an in-flow, empty <div data-greenware-overlay>.
       We style it (background, border, padding) and fill it. The core
       owns the mount point and initial min-height; the overlay remains
       inside the same parent container that held the original form. */
    "[data-greenware-overlay]{",
    "  background:#ffffff;",
    "  border:1px solid #e2e8f0;",
    "  border-radius:12px;",
    "  padding:24px;",
    "  width:100%;",
    "  max-width:100%;",
    "  min-width:0;",
    "  overflow:hidden;",
    "  box-sizing:border-box;",
    "  font-family:system-ui,-apple-system,'Segoe UI',sans-serif;",
    "  color:#0f172a;",
    "  font-size:16px;",
    "  line-height:1.5;",
    "  box-shadow:0 1px 3px rgba(15, 23, 42, 0.04),0 8px 24px rgba(15, 23, 42, 0.08);",
    "  --gw-bg:#ffffff;",
    "  --gw-text-primary:#0f172a;",
    "  --gw-text-muted:#64748b;",
    "  --gw-border:#e2e8f0;",
    "  --gw-brand:#10b981;",
    "  --gw-brand-hover:#059669;",
    "  --gw-radius-field:8px;",
    "  --gw-radius-button:10px;",
    "  --gw-radius-container:12px;",
    "  --gw-ease-out:" + EASE_OUT + ";",
    "  --gw-ease-spring:" + EASE_SPRING + ";",
    "  --gw-ease-exit:" + EASE_EXIT + ";",
    "}",
    "[data-greenware-overlay] *,[data-greenware-overlay] *::before,[data-greenware-overlay] *::after{box-sizing:border-box;}",

    /* Status card + motion. */
    ".gw-status{",
    "  display:flex;",
    "  flex-direction:column;",
    "  gap:8px;",
    "  opacity:0;",
    "  transform:translateY(8px);",
    "  transition:opacity 250ms var(--gw-ease-out) 150ms,transform 250ms var(--gw-ease-out) 150ms;",
    "  will-change:opacity,transform;",
    "}",
    ".gw-status--visible{opacity:1;transform:translateY(0);}",
    ".gw-status--leaving{opacity:0;transform:translateY(-8px);transition:opacity 180ms var(--gw-ease-exit),transform 180ms var(--gw-ease-exit);}",
    ".gw-status__message{",
    "  font-size:20px;",
    "  font-weight:500;",
    "  color:var(--gw-text-primary);",
    "  line-height:1.4;",
    "  min-height:1.4em;",
    "  transition:opacity " + SPINNER_CROSSFADE_MS + "ms var(--gw-ease-out);",
    "}",
    ".gw-status__message--fading{opacity:0;}",
    ".gw-status__message::after{",
    "  content:'';",
    "  display:inline-block;",
    "  width:1em;",
    "  text-align:left;",
    "  animation:gw-dots 1500ms steps(4,end) infinite;",
    "}",
    "@keyframes gw-dots{",
    "  0%{content:'';}",
    "  25%{content:'.';}",
    "  50%{content:'..';}",
    "  75%{content:'...';}",
    "  100%{content:'';}",
    "}",
    ".gw-status__context{font-size:13px;color:var(--gw-text-muted);}",

    /* Action container. */
    ".gw-action{",
    "  width:100%;",
    "  max-width:100%;",
    "  min-width:0;",
    "  overflow:hidden;",
    "  opacity:0;",
    "  transform:translateY(12px) scale(0.98);",
    "  transition:opacity 300ms var(--gw-ease-spring) 150ms,transform 300ms var(--gw-ease-spring) 150ms;",
    "  will-change:opacity,transform;",
    "}",
    ".gw-action--visible{opacity:1;transform:translateY(0) scale(1);}",
    ".gw-action__eyebrow{",
    "  font-size:12px;",
    "  font-weight:600;",
    "  text-transform:uppercase;",
    "  letter-spacing:0.05em;",
    "  color:var(--gw-brand);",
    "  margin:0 0 8px;",
    "}",
    ".gw-action__title{",
    "  font-size:20px;",
    "  font-weight:500;",
    "  color:var(--gw-text-primary);",
    "  margin:0 0 12px;",
    "  line-height:1.3;",
    "  overflow-wrap:anywhere;",
    "}",
    ".gw-action__title:focus{outline:none;}",
    ".gw-action__body{",
    "  font-size:16px;",
    "  color:var(--gw-text-primary);",
    "  margin:0 0 16px;",
    "  line-height:1.5;",
    "  overflow-wrap:anywhere;",
    "}",
    ".gw-action__cta{",
    "  display:inline-block;",
    "  max-width:100%;",
    "  padding:12px 20px;",
    "  border-radius:var(--gw-radius-button);",
    "  background:var(--gw-brand);",
    "  color:#ffffff;",
    "  text-decoration:none;",
    "  font-weight:600;",
    "  font-size:16px;",
    "  border:none;",
    "  cursor:pointer;",
    "  transition:background 150ms var(--gw-ease-out);",
    "  margin-top:8px;",
    "  overflow-wrap:anywhere;",
    "}",
    ".gw-action__cta:hover{background:var(--gw-brand-hover);}",
    ".gw-action__cta:focus{outline:2px solid var(--gw-brand);outline-offset:2px;}",
    ".gw-action__cta--secondary{",
    "  background:transparent;",
    "  color:var(--gw-brand);",
    "  border:1px solid var(--gw-border);",
    "}",
    ".gw-action__cta--secondary:hover{background:color-mix(in srgb,var(--gw-brand) 10%,transparent);}",

    /* Embed iframe. */
    ".gw-embed{display:flex;flex-direction:column;min-height:0;}",
    ".gw-embed__frame{",
    "  width:100%;",
    "  max-width:100%;",
    "  min-width:0;",
    "  height:min(640px,70vh);",
    "  min-height:600px;",
    "  max-height:720px;",
    "  border:none;",
    "  border-radius:var(--gw-radius-field);",
    "  background:var(--gw-bg);",
    "  display:block;",
    "}",
    "@media (max-width:480px){.gw-embed__frame{min-height:500px;}}",
    ".gw-skip-link{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden;}",
    ".gw-skip-link:focus{",
    "  position:static;width:auto;height:auto;",
    "  padding:8px 12px;",
    "  background:var(--gw-bg);",
    "  color:var(--gw-brand);",
    "  border:2px solid var(--gw-brand);",
    "  border-radius:var(--gw-radius-field);",
    "  display:inline-block;",
    "  margin-bottom:12px;",
    "}",
    ".gw-error__actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;}",

    /* Reduced-motion override. */
    "@media (prefers-reduced-motion:reduce){",
    "  [data-greenware-overlay] *{",
    "    animation-duration:0.01ms !important;",
    "    animation-iteration-count:1 !important;",
    "    transition-duration:150ms !important;",
    "    transition-property:opacity !important;",
    "  }",
    "  .gw-status,.gw-status--leaving{transform:none;}",
    "  .gw-action,.gw-action--visible{transform:none;}",
    "  .gw-status__message::after{animation:none;content:'...';}",
    "}"
  ].join("\n");

  function injectStyles() {
    if (document.getElementById("gw-default-ui-styles")) return;
    var style = document.createElement("style");
    style.id = "gw-default-ui-styles";
    style.textContent = STYLES;
    var head = document.head || document.getElementsByTagName("head")[0];
    head.insertBefore(style, head.firstChild);
  }

  // -------------------------------------------------------------------------
  // Per-form UI state — keyed by the form element so multiple forms on a
  // single page each get their own overlay.
  // -------------------------------------------------------------------------

  var uiStates = new WeakMap();

  function getUiState(form) {
    var s = uiStates.get(form);
    if (s) return s;
    s = {
      form: form,
      statusEl: null,
      statusMessageEl: null,
      contextEl: null,
      spinnerRotator: null,
      spinnerMsgIdx: 0,
      submittedEmail: null,
      pendingTimers: []
    };
    uiStates.set(form, s);
    return s;
  }

  function scheduleTimer(state, fn, delay) {
    var id = setTimeout(fn, delay);
    state.pendingTimers.push(id);
    return id;
  }

  function clearAllTimers(state) {
    for (var i = 0; i < state.pendingTimers.length; i++) clearTimeout(state.pendingTimers[i]);
    state.pendingTimers = [];
    if (state.spinnerRotator) { clearInterval(state.spinnerRotator); state.spinnerRotator = null; }
  }

  /** Find the core's overlay associated with this form. The core inserts
   *  it immediately after the target in normal document flow. The fallback
   *  keeps old/custom host shims working if they mount an overlay elsewhere. */
  function findOverlay(target) {
    if (target && target.nextElementSibling &&
        target.nextElementSibling.hasAttribute &&
        target.nextElementSibling.hasAttribute("data-greenware-overlay")) {
      return target.nextElementSibling;
    }
    return document.querySelector("[data-greenware-overlay]");
  }

  // -------------------------------------------------------------------------
  // Spinner rendering
  // -------------------------------------------------------------------------

  function renderSpinner(state) {
    var overlay = findOverlay(state.form);
    if (!overlay) return;
    if (state.statusEl && state.statusEl.parentNode === overlay) return;
    clearChildren(overlay);

    var status = el("div", {
      className: "gw-status",
      role: "status",
      "aria-live": "polite",
      "aria-atomic": "true",
      "aria-busy": "true",
      tabindex: "-1"
    });
    var msg = el("div", { className: "gw-status__message" }, DEFAULT_SPINNER_MESSAGES[0]);
    status.appendChild(msg);

    if (state.submittedEmail) {
      var context = el("div", { className: "gw-status__context" }, "for " + state.submittedEmail);
      status.appendChild(context);
      state.contextEl = context;
    }
    overlay.appendChild(status);
    state.statusEl = status;
    state.statusMessageEl = msg;

    requestAnimationFrame(function () { status.classList.add("gw-status--visible"); });

    state.spinnerMsgIdx = 0;
    state.spinnerRotator = setInterval(function () { rotateSpinnerMessage(state); }, SPINNER_ROTATE_MS);

    scheduleTimer(state, function () { try { status.focus(); } catch (_) {} }, 200);
  }

  function rotateSpinnerMessage(state) {
    if (!state.statusMessageEl) return;
    var next = (state.spinnerMsgIdx + 1) % DEFAULT_SPINNER_MESSAGES.length;
    state.spinnerMsgIdx = next;
    var message = state.statusMessageEl;
    message.classList.add("gw-status__message--fading");
    setTimeout(function () {
      message.textContent = DEFAULT_SPINNER_MESSAGES[next];
      message.classList.remove("gw-status__message--fading");
    }, SPINNER_CROSSFADE_MS);
  }

  function stopSpinner(state) {
    if (state.spinnerRotator) { clearInterval(state.spinnerRotator); state.spinnerRotator = null; }
    if (state.statusEl) state.statusEl.setAttribute("aria-busy", "false");
  }

  function fadeOutStatus(state, exitDuration, after) {
    if (!state.statusEl) { after(); return; }
    state.statusEl.classList.add("gw-status--leaving");
    setTimeout(function () {
      if (state.statusEl && state.statusEl.parentNode) {
        state.statusEl.parentNode.removeChild(state.statusEl);
      }
      state.statusEl = null;
      state.statusMessageEl = null;
      after();
    }, exitDuration);
  }

  // -------------------------------------------------------------------------
  // Action card normalization + rendering
  // -------------------------------------------------------------------------

  function normalizeAction(detail) {
    if (!detail || typeof detail !== "object") return genericErrorAction();
    var type = detail.type;
    if (type === "redirect") {
      if (!isSafeUrl(detail.url)) return genericErrorAction();
      return { type: "redirect", url: detail.url };
    }
    if (type === "embed") {
      if (!isSafeUrl(detail.url)) return genericErrorAction();
      return {
        type: "embed",
        provider: typeof detail.provider === "string" ? detail.provider : "iframe",
        url: detail.url,
        mobile_behavior: detail.mobile_behavior === "iframe" ? "iframe" : "redirect"
      };
    }
    if (type === "message") {
      var cta = null;
      if (detail.cta && typeof detail.cta === "object" && isSafeUrl(detail.cta.url)) {
        cta = {
          label: typeof detail.cta.label === "string" ? detail.cta.label : "Learn more",
          url: detail.cta.url
        };
      }
      return {
        type: "message",
        title: typeof detail.title === "string" ? detail.title : "",
        body: typeof detail.body === "string" ? detail.body : "",
        cta: cta
      };
    }
    if (type === "reject") {
      var alt = null;
      if (detail.alternative && typeof detail.alternative === "object" && isSafeUrl(detail.alternative.url)) {
        alt = {
          label: typeof detail.alternative.label === "string" ? detail.alternative.label : "Learn more",
          url: detail.alternative.url
        };
      }
      return {
        type: "reject",
        reason: typeof detail.reason === "string" ? detail.reason : "",
        alternative: alt
      };
    }
    return genericErrorAction();
  }

  function genericErrorAction() {
    return {
      type: "message",
      title: "Something went wrong",
      body: "We couldn't route your request. Please try again in a moment.",
      cta: null
    };
  }

  function renderAction(state, action) {
    switch (action.type) {
      case "redirect": return renderRedirect(state, action);
      case "embed":
        if (isMobileViewport() && action.mobile_behavior !== "iframe") {
          return renderEmbedAsMobileRedirect(state, action);
        }
        return renderEmbed(state, action);
      case "message": return renderMessage(state, action);
      case "reject": return renderReject(state, action);
      default: return renderMessage(state, genericErrorAction());
    }
  }

  function renderRedirect(state, action) {
    var container = el("div", { className: "gw-action", role: "region" });
    var provider = providerDisplayName(action.url);
    var title = el("h2", { className: "gw-action__title", tabindex: "-1" }, "Taking you to " + provider);
    container.appendChild(title);
    container.appendChild(el("p", { className: "gw-action__body" }, "Hold on a moment — we're opening the right page."));
    scheduleTimer(state, function () { try { title.focus(); } catch (_) {} }, 200);
    scheduleTimer(state, function () {
      if (isSafeUrl(action.url)) {
        window.location.href = action.url;
      } else {
        clearChildren(container);
        container.appendChild(el("h2", { className: "gw-action__title" }, "Something went wrong"));
        container.appendChild(el("p", { className: "gw-action__body" }, "The destination URL was invalid."));
      }
    }, REDIRECT_HANDOFF_MS);
    return container;
  }

  function renderEmbed(state, action) {
    var container = el("div", { className: "gw-action gw-embed", role: "region", "aria-label": "Scheduling" });
    container.appendChild(el("p", { className: "gw-action__eyebrow" }, "Your match"));
    var title = el("h2", { className: "gw-action__title", tabindex: "-1" }, "Pick a time that works");
    container.appendChild(title);
    container.appendChild(el("a", { className: "gw-skip-link", href: "#gw-after-embed" }, "Skip scheduling widget"));

    if (!isSafeUrl(action.url)) {
      clearChildren(container);
      container.appendChild(el("h2", { className: "gw-action__title" }, "Something went wrong"));
      container.appendChild(el("p", { className: "gw-action__body" }, "The scheduling URL was invalid."));
      return container;
    }

    container.appendChild(el("iframe", {
      className: "gw-embed__frame",
      src: action.url,
      title: "Scheduling widget",
      sandbox: "allow-scripts allow-forms allow-same-origin",
      loading: "lazy"
    }));
    container.appendChild(el("div", { id: "gw-after-embed", tabindex: "-1" }));
    scheduleTimer(state, function () { try { title.focus(); } catch (_) {} }, 200);
    return container;
  }

  function renderEmbedAsMobileRedirect(state, action) {
    var container = el("div", { className: "gw-action", role: "region" });
    var title = el("h2", { className: "gw-action__title", tabindex: "-1" }, "Open scheduling");
    container.appendChild(title);
    container.appendChild(el("p", { className: "gw-action__body" }, "We'll open the scheduler in a new tab so you can pick a time."));
    container.appendChild(el("a", {
      className: "gw-action__cta",
      href: action.url,
      target: "_blank",
      rel: "noopener noreferrer"
    }, "Open " + providerDisplayName(action.url)));
    scheduleTimer(state, function () { try { title.focus(); } catch (_) {} }, 200);
    return container;
  }

  function renderMessage(state, action) {
    var container = el("div", { className: "gw-action", role: "region" });
    var title = null;
    if (action.title) {
      title = el("h2", { className: "gw-action__title", tabindex: "-1" }, action.title);
      container.appendChild(title);
      scheduleTimer(state, function () { try { title.focus(); } catch (_) {} }, 200);
    }
    if (action.body) {
      var body = el("p", { className: "gw-action__body" });
      appendBodyWithLineBreaks(body, action.body);
      container.appendChild(body);
    }
    if (action.cta && isSafeUrl(action.cta.url)) {
      var cta = el("a", {
        className: "gw-action__cta",
        href: action.cta.url,
        target: "_blank",
        rel: "noopener noreferrer"
      }, action.cta.label);
      container.appendChild(cta);
      if (!title) scheduleTimer(state, function () { try { cta.focus(); } catch (_) {} }, 200);
    }
    return container;
  }

  function renderReject(state, action) {
    var container = el("div", { className: "gw-action", role: "region" });
    var reason = el("p", { className: "gw-action__body", tabindex: "-1" }, action.reason);
    reason.style.fontSize = "18px";
    reason.style.lineHeight = "1.5";
    container.appendChild(reason);
    if (action.alternative && isSafeUrl(action.alternative.url)) {
      container.appendChild(el("a", {
        className: "gw-action__cta gw-action__cta--secondary",
        href: action.alternative.url,
        target: "_blank",
        rel: "noopener noreferrer"
      }, action.alternative.label));
    }
    scheduleTimer(state, function () { try { reason.focus(); } catch (_) {} }, 200);
    return container;
  }

  function renderErrorCard(state, code) {
    var container = el("div", { className: "gw-action", role: "region" });
    var title = el("h2", { className: "gw-action__title", tabindex: "-1" }, "Something went wrong");
    container.appendChild(title);
    container.appendChild(el(
      "p",
      { className: "gw-action__body" },
      code === "CLIENT_TIMEOUT"
        ? "This is taking longer than expected."
        : "We couldn't complete your request. Please try again in a moment."
    ));
    var actions = el("div", { className: "gw-error__actions" });
    var retry = el("button", { className: "gw-action__cta", type: "button" }, "Try again");
    retry.addEventListener("click", function () { fireReset(state); });
    actions.appendChild(retry);
    container.appendChild(actions);
    scheduleTimer(state, function () { try { title.focus(); } catch (_) {} }, 200);
    return container;
  }

  function renderExpiredCard(state) {
    var container = el("div", { className: "gw-action", role: "region" });
    var title = el("h2", { className: "gw-action__title", tabindex: "-1" }, "Session expired");
    container.appendChild(title);
    container.appendChild(el(
      "p",
      { className: "gw-action__body" },
      "This page sat idle too long. Start over and we'll route you again."
    ));
    var actions = el("div", { className: "gw-error__actions" });
    var retry = el("button", { className: "gw-action__cta", type: "button" }, "Start over");
    retry.addEventListener("click", function () { fireReset(state); });
    actions.appendChild(retry);
    container.appendChild(actions);
    scheduleTimer(state, function () { try { title.focus(); } catch (_) {} }, 200);
    return container;
  }

  // -------------------------------------------------------------------------
  // Mount + transition action into the overlay
  // -------------------------------------------------------------------------

  function mountAction(state, action, exitDuration, enterDelay) {
    fadeOutStatus(state, exitDuration, function () {
      setTimeout(function () {
        var overlay = findOverlay(state.form);
        if (!overlay) return;
        var actionEl = renderAction(state, action);
        overlay.appendChild(actionEl);
        requestAnimationFrame(function () {
          requestAnimationFrame(function () { actionEl.classList.add("gw-action--visible"); });
        });
      }, enterDelay);
    });
  }

  function mountTerminalCard(state, card) {
    if (state.statusEl && state.statusEl.parentNode) {
      state.statusEl.parentNode.removeChild(state.statusEl);
      state.statusEl = null;
    }
    var overlay = findOverlay(state.form);
    if (!overlay) return;
    overlay.appendChild(card);
    requestAnimationFrame(function () { card.classList.add("gw-action--visible"); });
  }

  function fireReset(state) {
    // Fire on the form so the core's listener runs (it restores the
    // form lock + tears down the overlay we live inside).
    try {
      state.form.dispatchEvent(new CustomEvent("greenware:reset", {
        detail: {}, bubbles: true, cancelable: false
      }));
    } catch (_) {}
  }

  // -------------------------------------------------------------------------
  // Event listeners — wire to the core's CustomEvents
  // -------------------------------------------------------------------------

  function isGreenwareTarget(target) {
    return target && typeof target.hasAttribute === "function" &&
      (target.hasAttribute("data-greenware-attach") || target.hasAttribute("data-greenware-provider"));
  }

  function onSubmit(ev) {
    if (!isGreenwareTarget(ev.target)) return;
    var detail = ev.detail || {};
    var state = getUiState(ev.target);
    state.submittedEmail = detail.lead && typeof detail.lead.email === "string"
      ? detail.lead.email : null;
  }

  function onProcessing(ev) {
    if (!isGreenwareTarget(ev.target)) return;
    var state = getUiState(ev.target);
    if (!state.statusEl) renderSpinner(state);
  }

  function onWait(ev) {
    if (!isGreenwareTarget(ev.target)) return;
    var state = getUiState(ev.target);
    if (!state.statusEl) renderSpinner(state);
  }

  function onAction(ev) {
    if (!isGreenwareTarget(ev.target)) return;
    // Cancel the core's default redirect-immediately so we can render
    // the 600ms handoff card before navigating.
    ev.preventDefault();
    var state = getUiState(ev.target);
    var action = normalizeAction(ev.detail);
    stopSpinner(state);
    var reduced = prefersReducedMotion();
    var exitDuration = reduced ? 150 : 180;
    var enterDelay = reduced ? 150 : 150;
    mountAction(state, action, exitDuration, enterDelay);
  }

  function onError(ev) {
    if (!isGreenwareTarget(ev.target)) return;
    var state = getUiState(ev.target);
    var detail = ev.detail || {};
    stopSpinner(state);
    mountTerminalCard(state, renderErrorCard(state, detail.errorCode));
  }

  function onExpired(ev) {
    if (!isGreenwareTarget(ev.target)) return;
    var state = getUiState(ev.target);
    stopSpinner(state);
    mountTerminalCard(state, renderExpiredCard(state));
  }

  function onReset(ev) {
    if (!isGreenwareTarget(ev.target)) return;
    var state = getUiState(ev.target);
    clearAllTimers(state);
    state.statusEl = null;
    state.statusMessageEl = null;
    state.contextEl = null;
    state.submittedEmail = null;
    // The core's reset listener tears down the overlay; nothing more
    // for the UI to do.
  }

  function install() {
    injectStyles();
    document.addEventListener("greenware:submit", onSubmit, false);
    document.addEventListener("greenware:processing", onProcessing, false);
    document.addEventListener("greenware:wait", onWait, false);
    document.addEventListener("greenware:action", onAction, false);
    document.addEventListener("greenware:error", onError, false);
    document.addEventListener("greenware:expired", onExpired, false);
    document.addEventListener("greenware:reset", onReset, false);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", install);
  } else {
    install();
  }

  // Public API — version + a manual refresh hook for advanced cases.
  window.GreenwareDefaultUi = { version: VERSION };
})();
