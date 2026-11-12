// Shared form-feedback helpers — the reusable core of the marks-entry fix
// (public/js/test-scores.js), extracted so every form surfaces failures the
// same way: friendly messages, inline field errors, busy-button restore.
//
// The contract every helper here keeps: FEEDBACK NEVER VANISHES.
//   • fetchJson never throws and never assumes the response is JSON — an
//     expired session (HTML login redirect), a proxy error page or a dropped
//     mobile connection all become an actionable message, not a stuck button.
//   • busy() buttons restore on bfcache pageshow, so Back never lands on a
//     dead "Saving…" button.
//   • inline errors render next to the field; general errors go to Toast.
(function () {
  'use strict';

  // ── Response reading (mirrors test-scores.js) ──────────────────────────
  // JSON is the normal case; a non-JSON body means the request never reached
  // the API. Reporting the HTTP status/shape is what turns a bare "Save
  // failed." into something the user can act on.
  function readApiResponse(res) {
    return res.text().then(function (text) {
      try {
        return { payload: JSON.parse(text), status: res.status, redirected: res.redirected };
      } catch (err) {
        return { nonJson: true, status: res.status, redirected: res.redirected, body: text };
      }
    }, function () {
      return { nonJson: true, status: res.status, redirected: res.redirected, body: '' };
    });
  }

  function describeApiResponse(r, fallback) {
    var action = fallback || 'The request';
    if (r.nonJson) {
      if (!r.status) return 'No response from the server — check the connection and try again.';
      if (r.redirected) return 'Your session expired — sign in again, then reload this page.';
      return 'The server replied with an unexpected page (HTTP ' + r.status + '). Please try again.';
    }
    if (r.payload && r.payload.message) return r.payload.message;
    if (r.status === 401) return 'Your session is no longer valid — sign in again and retry.';
    if (r.status === 403) return 'You are not allowed to do that.';
    if (r.status === 404) return 'That record no longer exists — reload the page.';
    if (r.status >= 500) return 'Server error (HTTP ' + r.status + ') — please try again in a moment.';
    return action + ' failed (HTTP ' + r.status + ').';
  }

  // Errors we phrase for the user are marked, so a catch can tell them apart
  // from a raw engine message such as Chrome's "Failed to fetch".
  function friendlyError(message) {
    var err = new Error(message);
    err.friendly = true;
    return err;
  }

  function bearerAuth() {
    var meta = document.querySelector('meta[name="auth-token"]');
    return meta && meta.content ? { Authorization: 'Bearer ' + meta.content } : {};
  }

  // fetch + safe read in one. NEVER rejects: the result always carries
  // { ok, status, payload, message } — ok is true only for a 2xx JSON body
  // with status:'success' (the portal's API envelope). CSRF + Bearer headers
  // are attached automatically unless the caller already set them; FormData
  // bodies keep their multipart boundary (no Content-Type override).
  function fetchJson(url, opts) {
    opts = opts || {};
    var method = (opts.method || 'GET').toUpperCase();
    var headers = Object.assign({}, bearerAuth(), opts.headers || {});
    if (method !== 'GET' && method !== 'HEAD' && window.CSRF_TOKEN && !headers['X-CSRF-Token']) {
      headers['X-CSRF-Token'] = window.CSRF_TOKEN;
    }
    if (opts.body && !(opts.body instanceof FormData) && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }
    return fetch(url, Object.assign({}, opts, { method: method, headers: headers }))
      .then(readApiResponse)
      .then(function (r) {
        var ok = !r.nonJson && r.status >= 200 && r.status < 300 && r.payload && r.payload.status === 'success';
        return {
          ok: ok,
          status: r.status,
          payload: r.payload,
          nonJson: !!r.nonJson,
          redirected: !!r.redirected,
          message: ok ? (r.payload.message || '') : describeApiResponse(r, opts.action)
        };
      })
      .catch(function (err) {
        return {
          ok: false,
          status: 0,
          payload: null,
          nonJson: true,
          redirected: false,
          message: err && err.friendly ? err.message : 'No response from the server — check the connection and try again.'
        };
      });
  }

  // ── Inline field errors ────────────────────────────────────────────────
  function resolveEl(input) {
    return typeof input === 'string' ? document.getElementById(input) : input;
  }

  function setFieldError(input, message) {
    var el = resolveEl(input);
    if (!el) return;
    var field = el.closest ? el.closest('.field') : null;
    var host = field || el.parentNode;
    if (!host) return;
    var errEl = field ? field.querySelector('.field-error') : null;
    if (!errEl) {
      errEl = document.createElement('p');
      errEl.className = 'field-error';
      errEl.setAttribute('role', 'alert');
      host.appendChild(errEl);
    }
    errEl.textContent = message;
    el.classList.add('input-invalid');
    el.setAttribute('aria-invalid', 'true');
  }

  function clearFieldError(input) {
    var el = resolveEl(input);
    if (!el) return;
    var field = el.closest ? el.closest('.field') : null;
    var errEl = field ? field.querySelector('.field-error') : null;
    if (errEl && errEl.parentNode) errEl.parentNode.removeChild(errEl);
    el.classList.remove('input-invalid');
    el.removeAttribute('aria-invalid');
  }

  function clearFieldErrors(form) {
    var scope = resolveEl(form) || document;
    scope.querySelectorAll('.field-error').forEach(function (el) {
      if (el.parentNode) el.parentNode.removeChild(el);
    });
    scope.querySelectorAll('.input-invalid').forEach(function (el) {
      el.classList.remove('input-invalid');
      el.removeAttribute('aria-invalid');
    });
  }

  // ── Inline form status (the #scores-status pattern, generalized) ───────
  // Returns { set(text, ok), clear() }. The span is created next to the
  // anchor (usually the submit button) if the page doesn't ship one, so an
  // old cached template can never swallow the message.
  function statusFor(anchor) {
    var el = resolveEl(anchor);
    var span = null;
    function ensure() {
      if (span && span.parentNode) return span;
      span = document.createElement('span');
      span.className = 'form-status';
      span.setAttribute('role', 'status');
      if (el && el.parentNode) el.parentNode.insertBefore(span, el.nextSibling);
      else document.body.appendChild(span);
      return span;
    }
    return {
      set: function (text, ok) {
        var s = ensure();
        s.textContent = text || '';
        s.classList.toggle('ok', !!ok);
        s.classList.toggle('error', !ok);
      },
      clear: function () {
        if (span) span.textContent = '';
      }
    };
  }

  // ── Busy buttons with bfcache restore ──────────────────────────────────
  // A slow POST on a phone often ends with the browser restoring the page
  // from the back/forward cache — a button left disabled with "Saving…"
  // fires no click at all, so the next press looks dead. Every busy() button
  // is registered here and restored on pageshow (persisted).
  var busyButtons = [];

  function busy(btn, label) {
    var el = resolveEl(btn);
    if (!el) return function () {};
    var original = el.textContent;
    var entry = { el: el, original: original };
    busyButtons.push(entry);
    el.disabled = true;
    if (label) el.textContent = label;
    var restored = false;
    function restore() {
      if (restored) return;
      restored = true;
      el.disabled = false;
      el.textContent = original;
      var i = busyButtons.indexOf(entry);
      if (i !== -1) busyButtons.splice(i, 1);
    }
    el._restoreBusy = restore;
    return restore;
  }

  if (window.addEventListener) {
    window.addEventListener('pageshow', function (e) {
      if (e && e.persisted) {
        busyButtons.slice().forEach(function (entry) {
          if (entry.el._restoreBusy) entry.el._restoreBusy();
        });
      }
    });
  }

  window.FormFeedback = {
    readApiResponse: readApiResponse,
    describeApiResponse: describeApiResponse,
    friendlyError: friendlyError,
    bearerAuth: bearerAuth,
    fetchJson: fetchJson,
    setFieldError: setFieldError,
    clearFieldError: clearFieldError,
    clearFieldErrors: clearFieldErrors,
    statusFor: statusFor,
    busy: busy
  };
})();