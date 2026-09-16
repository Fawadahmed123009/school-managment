/**
 * Student Export page — scope picker, field toggling, and select-all.
 *
 * Data is passed from the server via <script type="application/json"> islands
 * in the EJS template (CSP-safe — no inline scripts).
 */
(function () {
  // ── Read data islands ──────────────────────────────────────────────────────
  var classesData = [];
  var classesEl = document.getElementById("export-classes-data");
  if (classesEl) {
    try { classesData = JSON.parse(classesEl.textContent) || []; } catch (e) { /* empty */ }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  function buildPicker(container, items, name, cssClass) {
    if (!container) return;
    var wrap = container.querySelector(".picker-items");
    if (!wrap) return;
    wrap.innerHTML = "";

    if (items.length === 0) {
      var muted = document.createElement("span");
      muted.className = "muted";
      muted.style.cssText = "font-size:13px;";
      muted.textContent = "No classes available";
      wrap.appendChild(muted);
      return;
    }

    items.forEach(function (item) {
      var label = document.createElement("label");
      label.style.cssText =
        "display:flex;align-items:center;gap:6px;padding:6px 10px;border:1px solid var(--border);" +
        "border-radius:6px;cursor:pointer;font-size:13px;background:#fff;min-width:180px;";

      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.name = name;
      cb.value = item._id;
      cb.className = cssClass;
      cb.disabled = true; // enabled only when scope matches

      label.appendChild(cb);
      label.appendChild(document.createTextNode(" " + item.name));
      wrap.appendChild(label);

      // Highlight on check/uncheck
      cb.addEventListener("change", function () {
        label.style.borderColor = this.checked ? "var(--primary, #1e3a5f)" : "var(--border)";
        label.style.background = this.checked ? "#f0f4f8" : "#fff";
        updateSelectAllState(container, cssClass);
      });
    });
  }

  function updateSelectAllState(container, cssClass) {
    var btn = container.querySelector(".select-all-btn");
    if (!btn) return;
    var cbs = container.querySelectorAll("." + cssClass);
    var allChecked = cbs.length > 0 && Array.from(cbs).every(function (cb) { return cb.checked; });
    btn.textContent = allChecked ? "Deselect all" : "Select all";
  }

  function toggleAllInPicker(container, cssClass) {
    var cbs = container.querySelectorAll("." + cssClass);
    var allChecked = cbs.length > 0 && Array.from(cbs).every(function (cb) { return cb.checked; });
    cbs.forEach(function (cb) {
      if (cb.disabled) return;
      cb.checked = !allChecked;
      var label = cb.closest("label");
      if (label) {
        label.style.borderColor = cb.checked ? "var(--primary, #1e3a5f)" : "var(--border)";
        label.style.background = cb.checked ? "#f0f4f8" : "#fff";
      }
    });
    updateSelectAllState(container, cssClass);
  }

  // ── Build pickers ──────────────────────────────────────────────────────────
  var classPicker = document.getElementById("classPicker");

  buildPicker(classPicker, classesData, "classes", "class-cb");

  // Wire up "Select all" button
  var classSelectAll = classPicker ? classPicker.querySelector(".select-all-btn") : null;
  if (classSelectAll) {
    classSelectAll.addEventListener("click", function () {
      toggleAllInPicker(classPicker, "class-cb");
    });
  }

  // ── Scope toggle ───────────────────────────────────────────────────────────
  var scopeEl = document.getElementById("scope");
  if (!scopeEl) return;

  function updatePickers() {
    var val = scopeEl.value;
    classPicker.style.display = val === "class" ? "" : "none";
    // Disable picker inputs when not active so their values aren't submitted
    classPicker.querySelectorAll("input").forEach(function (el) { el.disabled = val !== "class"; });
  }

  scopeEl.addEventListener("change", updatePickers);
  updatePickers();

  // ── Field toggling (Fields to include panel) ───────────────────────────────
  var toggleBtn = document.getElementById("toggleAllFields");
  if (toggleBtn) {
    toggleBtn.addEventListener("click", function () {
      var cbs = document.querySelectorAll(".field-cb");
      var allChecked = Array.from(cbs).every(function (cb) { return cb.checked; });
      cbs.forEach(function (cb) {
        cb.checked = !allChecked;
        var label = cb.closest("label");
        if (label) {
          label.style.borderColor = cb.checked ? "var(--primary, #1e3a5f)" : "var(--border)";
          label.style.background = cb.checked ? "#f0f4f8" : "#fff";
        }
      });
      toggleBtn.textContent = allChecked ? "Select all" : "Deselect all";
    });
  }

  // Highlight checked field labels on change
  document.querySelectorAll(".field-cb").forEach(function (cb) {
    cb.addEventListener("change", function () {
      var label = this.closest("label");
      if (!label) return;
      label.style.borderColor = this.checked ? "var(--primary, #1e3a5f)" : "var(--border)";
      label.style.background = this.checked ? "#f0f4f8" : "#fff";
    });
    // Initial state
    if (cb.checked) {
      var label = cb.closest("label");
      if (label) {
        label.style.borderColor = "var(--primary, #1e3a5f)";
        label.style.background = "#f0f4f8";
      }
    }
  });
})();
