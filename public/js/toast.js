// Toast notifications — the portal's non-blocking feedback layer.
//
// Why this exists: alert()/confirm() can be a silent no-op inside the installed
// PWA (prod HTTPS only), which made failed saves look dead — the root cause of
// the original marks-entry bug. Toasts are plain DOM in the page, so feedback
// is never suppressed by the WebView. Server-rendered .flash banners keep
// working unchanged (they now share this visual language via style.css).
//
// Usage:
//   Toast.success('Attendance saved.');
//   Toast.error('Could not reach the server — check the connection.');
//   Toast.warning('3 rows were skipped.');
//   Toast.info('…');
//   Toast.show(message, { type: 'error', title: 'Save failed', timeout: 0 });
//
// Errors are STICKY (timeout 0) until dismissed — a failed submission must
// never vanish on a timer. Other types auto-dismiss with a visible progress
// bar that pauses while the pointer hovers the toast.
(function () {
  'use strict';

  var TYPES = {
    success: { icon: '✓', title: 'Saved', timeout: 4500, role: 'status' },
    error: { icon: '✕', title: 'Something went wrong', timeout: 0, role: 'alert' },
    warning: { icon: '⚠', title: 'Check before continuing', timeout: 8000, role: 'alert' },
    info: { icon: 'ℹ', title: 'Heads up', timeout: 6000, role: 'status' }
  };
  var MAX_STACK = 5;
  var stack = null;

  function ensureStack() {
    if (stack && document.body.contains(stack)) return stack;
    stack = document.getElementById('toast-stack');
    if (!stack) {
      stack = document.createElement('div');
      stack.id = 'toast-stack';
      // One polite live region for the whole stack: screen readers announce
      // each appended toast without interrupting whatever they are reading.
      stack.setAttribute('aria-live', 'polite');
      stack.setAttribute('aria-label', 'Notifications');
      document.body.appendChild(stack);
    }
    return stack;
  }

  function dismiss(el) {
    if (!el || el._toastClosing) return;
    el._toastClosing = true;
    if (el._toastTiming) clearTimeout(el._toastTiming.timer);
    el.classList.add('toast-out');
    setTimeout(function () {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, 200);
  }

  // Auto-dismiss timer + progress bar, both pausable on hover so a message
  // being read is never yanked away mid-sentence. Timing state lives on the
  // element and listeners attach exactly once — re-arming a deduplicated
  // toast must never stack a second set of closures.
  function startTimer(el) {
    var t = el._toastTiming;
    t.startedAt = Date.now();
    t.timer = setTimeout(function () { dismiss(el); }, t.remaining);
    var progress = el.querySelector('.toast-progress');
    if (progress) {
      progress.style.animationDuration = t.remaining + 'ms';
      progress.style.animationPlayState = 'running';
    }
  }

  function pauseTimer(el) {
    var t = el._toastTiming;
    if (!t || el._toastClosing) return;
    clearTimeout(t.timer);
    t.remaining = Math.max(0, t.remaining - (Date.now() - t.startedAt));
    var progress = el.querySelector('.toast-progress');
    if (progress) progress.style.animationPlayState = 'paused';
  }

  function armTimer(el, timeout) {
    if (!timeout) return;
    if (!el._toastTiming) {
      el._toastTiming = { remaining: timeout, startedAt: 0, timer: null };
      el.addEventListener('mouseenter', function () { pauseTimer(el); });
      el.addEventListener('mouseleave', function () { startTimer(el); });
      // Touch devices have no hover — a tap holds the toast the same way.
      el.addEventListener('touchstart', function () { pauseTimer(el); }, { passive: true });
      el.addEventListener('touchend', function () { startTimer(el); });
    }
    clearTimeout(el._toastTiming.timer);
    el._toastTiming.remaining = timeout;
    startTimer(el);
  }

  function show(message, opts) {
    opts = opts || {};
    var type = TYPES[opts.type] ? opts.type : 'info';
    var cfg = TYPES[type];
    var text = String(message == null ? '' : message);
    if (!text) return null;
    var host = ensureStack();

    // Deduplicate: the same message+type already on screen gets its timer
    // reset and a brief bump instead of stacking an identical copy.
    var key = type + '|' + text;
    var existing = null;
    for (var i = 0; i < host.children.length; i++) {
      if (host.children[i]._toastKey === key && !host.children[i]._toastClosing) {
        existing = host.children[i];
        break;
      }
    }
    if (existing) {
      var p = existing.querySelector('.toast-progress');
      if (p) {
        p.style.animation = 'none';
        // Force reflow so the progress animation restarts from full.
        void p.offsetWidth;
        p.style.animation = '';
      }
      existing.classList.remove('toast-bump');
      void existing.offsetWidth;
      existing.classList.add('toast-bump');
      armTimer(existing, opts.timeout != null ? opts.timeout : cfg.timeout);
      return existing;
    }

    // Cap the stack: drop the oldest non-error toast first — errors stay
    // until the user acknowledges them. Removal is synchronous here: a
    // closing node still occupies children until its exit timer fires, so
    // re-picking it would spin this loop forever on a rapid burst.
    while (host.children.length >= MAX_STACK) {
      var oldest = null;
      for (var j = 0; j < host.children.length; j++) {
        var candidate = host.children[j];
        if (!candidate.classList.contains('toast-error') && !candidate._toastClosing) { oldest = candidate; break; }
      }
      if (!oldest) break; // only sticky errors / closing nodes remain
      dismiss(oldest);
      if (oldest.parentNode) oldest.parentNode.removeChild(oldest);
    }

    var el = document.createElement('div');
    el.className = 'toast toast-' + type;
    el.setAttribute('role', cfg.role);
    el._toastKey = key;

    var icon = document.createElement('span');
    icon.className = 'toast-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = cfg.icon;
    el.appendChild(icon);

    var body = document.createElement('div');
    body.className = 'toast-body';
    var title = document.createElement('p');
    title.className = 'toast-title';
    title.textContent = opts.title || cfg.title;
    body.appendChild(title);
    var msg = document.createElement('p');
    msg.className = 'toast-msg';
    // textContent only — server messages can contain user input (names,
    // roll numbers); never interpret them as HTML.
    msg.textContent = text;
    body.appendChild(msg);
    el.appendChild(body);

    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'toast-close';
    close.setAttribute('aria-label', 'Dismiss notification');
    close.textContent = '×';
    close.addEventListener('click', function () { dismiss(el); });
    el.appendChild(close);

    var timeout = opts.timeout != null ? opts.timeout : cfg.timeout;
    if (timeout) {
      var progress = document.createElement('span');
      progress.className = 'toast-progress';
      progress.setAttribute('aria-hidden', 'true');
      el.appendChild(progress);
    }

    host.appendChild(el);
    armTimer(el, timeout);
    return el;
  }

  window.Toast = {
    show: show,
    success: function (message, opts) { return show(message, Object.assign({ type: 'success' }, opts)); },
    error: function (message, opts) { return show(message, Object.assign({ type: 'error' }, opts)); },
    warning: function (message, opts) { return show(message, Object.assign({ type: 'warning' }, opts)); },
    info: function (message, opts) { return show(message, Object.assign({ type: 'info' }, opts)); }
  };
})();