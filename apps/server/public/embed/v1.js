/*!
 * Greenware Embed v1 — Core (events-only).
 * https://greenware.dev
 *
 * Discovers `<form data-greenware-attach>`, intercepts submit, calls
 * /api/submit, long-polls /api/session/:id, and emits CustomEvents on
 * the form for each lifecycle step:
 *
 *   greenware:submit   { lead, formId }                  cancelable
 *   greenware:processing { formId }
 *   greenware:wait     { sessionId, readToken }
 *   greenware:action   { type, ...action fields }
 *   greenware:error    { errorCode, problem?, fix? }
 *   greenware:expired  {}
 *   greenware:reset    {}
 *
 * Owns ZERO UI beyond a body-level overlay container (positioned over
 * the form, empty by default) and an a11y interaction lock during the
 * wait (`inert` + `aria-hidden` + `pointer-events: none`).
 *
 * The opinionated spinner / action cards / motion live in
 * `v1-default-ui.js`, which subscribes to these events and appends
 * children into the overlay container. Loading the default-UI gives
 * you the full UI; loading the core alone leaves UI to the host page.
 *
 * No build step. No dependencies. Served as-is from `/embed/v1.js`.
 */
(function () {
  "use strict";

  if (window.__greenwareV1Loaded) return;
  window.__greenwareV1Loaded = true;

  var CLIENT_TIMEOUT_MS = 60_000;
  var SUBMIT_TIMEOUT_MS = 15_000;
  var VERSION = "1.0.0";
  var ALLOWED_SCHEMES = ["https:"];

  // ---- Utilities ----------------------------------------------------------

  function isSafeUrl(url) {
    if (typeof url !== "string" || url.length === 0) return false;
    try { return ALLOWED_SCHEMES.indexOf(new URL(url).protocol) !== -1; }
    catch (_) { return false; }
  }

  /**
   * Convert a FormData snapshot into a plain object. Single-valued
   * fields become strings; repeat-key fields (checkbox group / multi-
   * select) become arrays preserving submission order. File entries
   * are dropped — only string values are forwarded to the server.
   */
  function formDataToObject(fd) {
    var out = {}, seen = {}, keys = [];
    var entries = fd.entries();
    var step = entries.next();
    while (!step.done) {
      var k = step.value[0];
      if (!Object.prototype.hasOwnProperty.call(seen, k)) {
        seen[k] = true;
        keys.push(k);
      }
      step = entries.next();
    }
    for (var ki = 0; ki < keys.length; ki++) {
      var key = keys[ki];
      var raw = fd.getAll(key);
      var all = [];
      for (var i = 0; i < raw.length; i++) {
        if (typeof raw[i] === "string") all.push(raw[i]);
      }
      if (all.length === 0) continue;
      out[key] = all.length === 1 ? all[0] : all;
    }
    return out;
  }

  function withProviderHiddenFields(providerUrl, session) {
    var u = new URL(providerUrl, window.location.href);
    var fields = session && session.hidden_fields ? session.hidden_fields : {};
    if (session && session.session_id && !fields.greenware_session_id) {
      fields.greenware_session_id = session.session_id;
    }
    if (session && session.read_token && !fields.greenware_read_token) {
      fields.greenware_read_token = session.read_token;
    }
    for (var key in fields) {
      if (!Object.prototype.hasOwnProperty.call(fields, key)) continue;
      if (typeof fields[key] === "string") u.searchParams.set(key, fields[key]);
    }
    return u.toString();
  }

  /** Walk the form for `{name: value}`. Adds explicit `false` for
   *  unchecked single checkboxes; checkbox-groups stay handled by
   *  FormData. */
  function collectFieldValues(form) {
    var fd = new FormData(form);
    var out = formDataToObject(fd);
    var checkboxes = form.querySelectorAll("input[type='checkbox']");
    var counts = {};
    for (var c = 0; c < checkboxes.length; c++) {
      var n = checkboxes[c].name;
      if (n) counts[n] = (counts[n] || 0) + 1;
    }
    for (var i = 0; i < checkboxes.length; i++) {
      var cb = checkboxes[i];
      if (cb.name && counts[cb.name] === 1 && !(cb.name in out)) {
        out[cb.name] = cb.checked;
      }
    }
    return out;
  }

  /** Dispatch a CustomEvent on `target`. Bubbles so document-level
   *  listeners work. Only `greenware:submit` is cancelable; others
   *  pass `cancelable: false` so a stray preventDefault doesn't
   *  silently affect lifecycle. */
  function emit(target, name, detail, cancelable) {
    var ev = new CustomEvent(name, {
      detail: detail,
      bubbles: true,
      cancelable: !!cancelable
    });
    try { target.dispatchEvent(ev); }
    catch (err) { try { console.error("greenware: listener threw on " + name + ":", err); } catch (_) {} }
    return ev;
  }

  function fetchWithTimeout(url, init, timeoutMs) {
    if (typeof AbortController !== "function") return fetch(url, init);
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, timeoutMs);
    var nextInit = {};
    init = init || {};
    for (var key in init) {
      if (Object.prototype.hasOwnProperty.call(init, key)) nextInit[key] = init[key];
    }
    nextInit.signal = controller.signal;
    return fetch(url, nextInit).finally(function () { clearTimeout(timer); });
  }

  // ---- Per-form instance --------------------------------------------------

  function createInstance(form) {
    return {
      form: form,
      endpoint: null,
      formId: null,
      sessionId: null,
      readToken: null,
      submitting: false,
      settled: false,
      timeoutTimer: null,
      origAriaHidden: null,
      origInert: null,
      origPointerEvents: null,
      origDisplay: null,
      overlay: null,
      pendingTimers: []
    };
  }

  function scheduleTimer(inst, fn, delay) {
    var id = setTimeout(fn, delay);
    inst.pendingTimers.push(id);
    return id;
  }

  function clearAllTimers(inst) {
    for (var i = 0; i < inst.pendingTimers.length; i++) clearTimeout(inst.pendingTimers[i]);
    inst.pendingTimers = [];
    if (inst.timeoutTimer) { clearTimeout(inst.timeoutTimer); inst.timeoutTimer = null; }
  }

  // ---- Install ------------------------------------------------------------

  function install() {
    var forms = document.querySelectorAll("form[data-greenware-attach]");
    for (var i = 0; i < forms.length; i++) attachForm(forms[i]);
    var providers = document.querySelectorAll("[data-greenware-provider]");
    for (var p = 0; p < providers.length; p++) attachProvider(providers[p]);
  }

  function attachForm(form, options) {
    if (form.__greenwareAttached) return;
    form.__greenwareAttached = true;

    var endpoint = ((options && options.endpoint) ||
      form.getAttribute("data-greenware-endpoint") || "").replace(/\/+$/, "");
    if (!endpoint) {
      console.warn("greenware: form is missing data-greenware-endpoint; falling back to current origin.");
    }

    var inst = createInstance(form);
    inst.endpoint = endpoint || window.location.origin;
    inst.formId = (options && options.formId) ||
      form.getAttribute("data-greenware-form-id") || null;

    form.setAttribute("data-greenware-version", VERSION);

    if (form.querySelector("input[type='file']")) {
      console.warn("greenware: <input type=\"file\"> detected — file uploads are not sent in v1.");
    }

    // Capture phase: front-run host-site libraries that bind on submit.
    form.addEventListener("submit", function (e) { handleSubmit(inst, e); }, true);

    // Reset listener: host pages (or the default UI's Try Again button)
    // emit `greenware:reset` to clear the locked state and tear down
    // the overlay so the user can try again.
    form.addEventListener("greenware:reset", function () { restoreForm(inst); }, false);
  }

  function endpointFor(target, options) {
    var endpoint = ((options && options.endpoint) ||
      target.getAttribute("data-greenware-endpoint") || "").replace(/\/+$/, "");
    return endpoint || window.location.origin;
  }

  function startSession(options) {
    options = options || {};
    var endpoint = (options.endpoint || window.location.origin).replace(/\/+$/, "");
    var body = {};
    if (options.provider) body.provider = options.provider;
    if (options.formId) body.form_id = options.formId;
    return fetch(endpoint + "/api/session/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "omit",
      body: JSON.stringify(body)
    }).then(function (res) {
      return res.text().then(function (text) {
        var parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch (_) {}
        if (!res.ok) {
          var err = new Error("Greenware session start failed");
          err.response = parsed;
          throw err;
        }
        return parsed;
      });
    });
  }

  function attachProvider(container, options) {
    if (!container || container.__greenwareProviderAttached) return;
    container.__greenwareProviderAttached = true;
    options = options || {};

    var endpoint = endpointFor(container, options);
    var provider = options.provider || container.getAttribute("data-greenware-provider") || "generic";
    var formId = options.formId || container.getAttribute("data-greenware-form-id") || null;
    var iframeSrc = options.iframeSrc || container.getAttribute("data-greenware-iframe-src");
    var existingIframe = typeof container.querySelector === "function"
      ? container.querySelector("iframe")
      : null;

    container.setAttribute("data-greenware-version", VERSION);
    container.setAttribute("data-greenware-provider", provider);
    if (existingIframe) registerProviderFrame(container, existingIframe);

    startSession({ endpoint: endpoint, provider: provider, formId: formId })
      .then(function (session) {
        container.__greenwareSession = session;
        container.__greenwareEndpoint = endpoint;
        emit(container, "greenware:provider-session", {
          sessionId: session.session_id,
          readToken: session.read_token,
          hiddenFields: session.hidden_fields,
          waitUrl: session.wait_url,
          provider: provider,
          formId: formId
        });

        if (iframeSrc) {
          var iframe = document.createElement("iframe");
          iframe.src = withProviderHiddenFields(iframeSrc, session);
          iframe.title = container.getAttribute("data-greenware-iframe-title") || "Form";
          iframe.loading = "lazy";
          iframe.setAttribute("data-greenware-provider-frame", "");
          iframe.style.width = "100%";
          iframe.style.border = "0";
          if (!iframe.style.minHeight) iframe.style.minHeight = "560px";
          registerProviderFrame(container, iframe);
          container.appendChild(iframe);
        }

        if (container.getAttribute("data-greenware-auto-wait") === "immediate") {
          waitForSession(container, session, { endpoint: endpoint });
        }
      })
      .catch(function (err) {
        emit(container, "greenware:error", {
          errorCode: "SESSION_START_FAILED",
          cause: err && err.message ? err.message : String(err)
        });
      });
  }

  function waitForSession(target, session, options) {
    if (!target || !session || typeof session.session_id !== "string" || typeof session.read_token !== "string") {
      return;
    }
    var existing = target.__greenwareWaitInstance;
    if (existing && existing.submitting) return;

    var inst = createInstance(target);
    inst.endpoint = ((options && options.endpoint) || target.__greenwareEndpoint ||
      target.getAttribute("data-greenware-endpoint") || window.location.origin).replace(/\/+$/, "");
    inst.formId = (options && options.formId) || target.getAttribute("data-greenware-form-id") || null;
    inst.sessionId = session.session_id;
    inst.readToken = session.read_token;
    inst.submitting = true;
    inst.settled = false;
    target.__greenwareWaitInstance = inst;
    lockForm(inst);
    mountOverlay(inst);
    emit(target, "greenware:wait", {
      sessionId: session.session_id,
      readToken: session.read_token
    });
    inst.timeoutTimer = setTimeout(function () { handleClientTimeout(inst); }, CLIENT_TIMEOUT_MS);
    longPoll(inst);
  }

  // ---- Submit pipeline ----------------------------------------------------

  function handleSubmit(inst, event) {
    event.preventDefault();
    if (inst.submitting) return;

    var form = inst.form;
    if (!form.reportValidity()) return; // browser-native UI handles errors

    // CRITICAL: snapshot FormData synchronously, before any framework
    // re-render that might unmount the form.
    var lead = collectFieldValues(form);

    // Fire the cancelable submit event BEFORE any network call. Host
    // pages can mutate `lead` in-place (it's a live reference), or
    // call preventDefault() to take over the request entirely.
    var submitEv = emit(inst.form, "greenware:submit",
      { lead: lead, formId: inst.formId }, true);
    if (submitEv.defaultPrevented) return;

    inst.submitting = true;
    inst.settled = false;

    // Lock the host form for the wait. Save originals so a future
    // restore can put them back exactly as they were.
    lockForm(inst);
    mountOverlay(inst);
    emit(inst.form, "greenware:processing", { formId: inst.formId });
    submitToServer(inst, lead);
  }

  function submitToServer(inst, lead) {
    fetchWithTimeout(inst.endpoint + "/api/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "omit",
      body: JSON.stringify({ lead: lead, form_id: inst.formId || undefined })
    }, SUBMIT_TIMEOUT_MS)
      .then(function (res) {
        return res.text().then(function (text) {
          var body = null;
          try { body = text ? JSON.parse(text) : null; } catch (_) {}
          if (!res.ok) {
            fail(inst, "SUBMIT_REJECTED", body);
            return null;
          }
          if (!body || typeof body.session_id !== "string" || typeof body.read_token !== "string") {
            fail(inst, "SUBMIT_REJECTED", body);
            return null;
          }
          inst.sessionId = body.session_id;
          inst.readToken = body.read_token;
          emit(inst.form, "greenware:wait",
            { sessionId: body.session_id, readToken: body.read_token });
          inst.timeoutTimer = setTimeout(function () { handleClientTimeout(inst); }, CLIENT_TIMEOUT_MS);
          longPoll(inst);
          return null;
        });
      })
      .catch(function (err) {
        fail(inst, err && err.name === "AbortError" ? "SUBMIT_TIMEOUT" : "NETWORK_ERROR", null, err);
      });
  }

  function longPoll(inst) {
    if (!inst.sessionId || !inst.readToken || inst.settled) return;
    fetch(inst.endpoint + "/api/session/" + encodeURIComponent(inst.sessionId) + "?wait=1", {
      method: "GET",
      headers: { Authorization: "Bearer " + inst.readToken },
      credentials: "omit"
    })
      .then(function (res) {
        if (inst.settled) return null;
        if (res.status === 404) { expired(inst); return null; }
        if (!res.ok) {
          scheduleTimer(inst, function () { longPoll(inst); }, 1000);
          return null;
        }
        return res.json();
      })
      .then(function (body) {
        if (inst.settled || !body) return;
        if (body.status === "ready") {
          markSettled(inst);
          dispatchAction(inst, body.action);
          return;
        }
        if (body.status === "failed") {
          fail(inst, body.error_code || "SUBMIT_FAILED", body);
          return;
        }
        if (body.status === "expired") {
          expired(inst);
          return;
        }
        if (body.status === "pending") {
          // Server hit its long-poll cap; CLIENT_TIMEOUT_MS guards us.
          longPoll(inst);
          return;
        }
        fail(inst, "UNKNOWN_STATUS", body);
      })
      .catch(function (err) {
        if (inst.settled) return;
        console.warn("greenware: long-poll failed: " + (err && err.message ? err.message : err));
        scheduleTimer(inst, function () { longPoll(inst); }, 1000);
      });
  }

  function markSettled(inst) {
    inst.settled = true;
    if (inst.timeoutTimer) { clearTimeout(inst.timeoutTimer); inst.timeoutTimer = null; }
  }

  function handleClientTimeout(inst) {
    if (inst.settled) return;
    fail(inst, "CLIENT_TIMEOUT");
  }

  // ---- Action / error / expired dispatch ---------------------------------

  function dispatchAction(inst, action) {
    if (!action || typeof action !== "object" || typeof action.type !== "string") {
      fail(inst, "UNKNOWN_STATUS");
      return;
    }
    // Build a flat detail with the action's own fields.
    var detail = { type: action.type };
    for (var k in action) {
      if (Object.prototype.hasOwnProperty.call(action, k) && k !== "type") detail[k] = action[k];
    }
    var ev = emit(inst.form, "greenware:action", detail, true);

    // Default behaviour: synchronous redirect when no listener cancels.
    // The default-UI script subscribes and calls preventDefault so it
    // can render a 600ms handoff card before navigating.
    if (!ev.defaultPrevented && action.type === "redirect" && isSafeUrl(action.url)) {
      window.location.href = action.url;
    }
  }

  function expired(inst) {
    markSettled(inst);
    clearAllTimers(inst);
    emit(inst.form, "greenware:expired", {});
    // Don't restore here — the host UI may still want to render an
    // expired card over the locked form. A subsequent `greenware:reset`
    // (e.g. from a Start Over button) restores the form.
  }

  function fail(inst, code, problemBody, cause) {
    markSettled(inst);
    clearAllTimers(inst);
    var detail = { errorCode: code };
    if (problemBody && typeof problemBody === "object") {
      if (typeof problemBody.problem === "string") detail.problem = problemBody.problem;
      if (typeof problemBody.fix === "string") detail.fix = problemBody.fix;
    }
    if (cause !== undefined) detail.cause = cause;
    emit(inst.form, "greenware:error", detail);
    // For NETWORK_ERROR / SUBMIT_REJECTED the form is restored so the
    // user can retry; for terminal failures after the wait started,
    // we leave the lock + overlay in place and let the host UI render
    // an error card. The host emits `greenware:reset` to clear it.
    if (code === "NETWORK_ERROR" || code === "SUBMIT_TIMEOUT" || code === "SUBMIT_REJECTED") {
      restoreForm(inst);
    }
  }

  // ---- Form / overlay lock ------------------------------------------------

  function lockForm(inst) {
    var form = inst.form;
    var submitBtn = form.querySelector("button[type='submit']") ||
      form.querySelector("input[type='submit']");
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.setAttribute("aria-disabled", "true");
    }
    inst.origAriaHidden = form.getAttribute("aria-hidden");
    inst.origInert = form.hasAttribute("inert") ? "" : null;
    inst.origPointerEvents = form.style.pointerEvents || "";
    form.setAttribute("aria-hidden", "true");
    form.setAttribute("inert", "");
    form.style.pointerEvents = "none";
  }

  function mountOverlay(inst) {
    if (inst.overlay) return;
    var form = inst.form;
    var rect = form.getBoundingClientRect();
    var overlay = document.createElement("div");
    overlay.setAttribute("data-greenware-overlay", "");
    overlay.setAttribute("data-greenware-version", VERSION);
    // Empty-by-default container. It replaces the host form in normal
    // document flow so the result is clipped/sized by the same parent
    // container as the original form.
    overlay.style.position = "relative";
    overlay.style.width = "100%";
    overlay.style.minHeight = Math.max(1, Math.ceil(rect.height)) + "px";
    overlay.style.pointerEvents = "auto";
    overlay.style.overflow = "hidden";
    if (form.parentNode && typeof form.parentNode.insertBefore === "function") {
      form.parentNode.insertBefore(overlay, form.nextSibling);
    } else {
      document.documentElement.appendChild(overlay);
    }
    inst.overlay = overlay;
    inst.origDisplay = form.style.display || "";
    form.style.display = "none";
  }

  function unmountOverlay(inst) {
    if (inst.overlay && inst.overlay.parentNode) {
      inst.overlay.parentNode.removeChild(inst.overlay);
    }
    inst.overlay = null;
  }

  /** Restore the host form so the user can retry. */
  function restoreForm(inst) {
    var form = inst.form;
    var submitBtn = form.querySelector("button[type='submit']") ||
      form.querySelector("input[type='submit']");
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.removeAttribute("aria-disabled");
    }
    form.removeAttribute("inert");
    if (inst.origInert === "") form.setAttribute("inert", "");
    if (inst.origAriaHidden === null) form.removeAttribute("aria-hidden");
    else form.setAttribute("aria-hidden", inst.origAriaHidden);
    form.style.pointerEvents = inst.origPointerEvents || "";
    if (inst.origDisplay !== null) {
      form.style.display = inst.origDisplay;
      inst.origDisplay = null;
    }
    inst.origInert = null;
    inst.origAriaHidden = null;
    inst.origPointerEvents = null;
    unmountOverlay(inst);
    inst.submitting = false;
    inst.settled = false;
    inst.sessionId = null;
    inst.readToken = null;
  }

  function looksLikeProviderSubmitMessage(data) {
    if (typeof data === "string") {
      try { data = JSON.parse(data); }
      catch (_) { return false; }
    }
    if (!data || typeof data !== "object") return false;
    var type = data.type || data.event || data.name;
    if (type === "greenware-provider-submit") return true;
    if (type === "Tally.FormSubmitted" || type === "Tally.FormSubmit") return true;
    if (type === "form-submit" || type === "form_submit" || type === "submit") return true;
    if (typeof type === "string" && type.toLowerCase().indexOf("submitted") !== -1) return true;
    return false;
  }

  function handleProviderMessage(event) {
    if (!looksLikeProviderSubmitMessage(event.data)) return;
    var target = providerTargetForMessage(event);
    if (!target || !target.__greenwareSession) return;
    waitForSession(target, target.__greenwareSession, {
      endpoint: target.__greenwareEndpoint || window.location.origin
    });
  }

  function providerTargetForMessage(event) {
    var providers = document.querySelectorAll("[data-greenware-provider]");
    for (var i = 0; i < providers.length; i++) {
      if (providerOwnsMessage(providers[i], event)) return providers[i];
    }
    return null;
  }

  function providerOwnsMessage(target, event) {
    var frame = target.__greenwareProviderFrame;
    if (!frame && typeof target.querySelector === "function") {
      frame = target.querySelector("[data-greenware-provider-frame]") || target.querySelector("iframe");
      if (frame) registerProviderFrame(target, frame);
    }
    if (!frame || !event || event.source !== frame.contentWindow) return false;
    var expectedOrigin = target.__greenwareProviderOrigin;
    return !expectedOrigin || event.origin === expectedOrigin;
  }

  function registerProviderFrame(container, iframe) {
    if (!iframe) return;
    container.__greenwareProviderFrame = iframe;
    var explicitOrigin = container.getAttribute("data-greenware-provider-origin");
    container.__greenwareProviderOrigin = explicitOrigin || originForFrame(iframe);
  }

  function originForFrame(iframe) {
    var src = iframe.src || (iframe.getAttribute && iframe.getAttribute("src")) || "";
    if (!src) return null;
    try { return new URL(src, window.location.href).origin; }
    catch (_) { return null; }
  }

  // ---- Boot ---------------------------------------------------------------

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", install);
  } else {
    install();
  }
  if (typeof window.addEventListener === "function") {
    window.addEventListener("message", handleProviderMessage, false);
  }

  /**
   * Public API. Tiny on purpose — the embed is event-driven, host pages
   * subscribe via addEventListener on the form (or any ancestor).
   */
  window.Greenware = {
    version: VERSION,
    /** Re-scan the DOM for newly-added forms, OR attach a specific
     *  form element programmatically. */
    attach: function (form, options) {
      if (!form) { install(); return; }
      attachForm(form, options || {});
    },
    startSession: startSession,
    attachProvider: attachProvider,
    waitForSession: waitForSession,
    // Internals — for tests + advanced integrations only.
    __internals: {
      formDataToObject: formDataToObject,
      withProviderHiddenFields: withProviderHiddenFields,
      looksLikeProviderSubmitMessage: looksLikeProviderSubmitMessage,
      providerOwnsMessage: providerOwnsMessage
    }
  };
})();
