/**
 * Dynamic "Applies to" rows for Subject create / edit forms.
 * Externalised from inline <script> so the CSP (script-src 'self') allows it.
 *
 * Expected DOM:
 *   #appliesToRows          – container holding .applies-to-row divs
 *   #appliesToCount         – hidden input tracking row count
 *   #addAppliesToRow        – the "+ Add class level" button
 *
 * Each row carries indexed fields: classLevel_<N> OR gradeLevel_<N>,
 * required_<N>, wholeGrade_<N>.
 * The class level options are read from a JSON script block (#classLevelOptions).
 *
 * When the "Whole grade (any group)" checkbox is checked, the ClassLevel
 * dropdown is replaced by a simple gradeLevel dropdown (PG–12).
 */
(function () {
  var container  = document.getElementById("appliesToRows");
  var countField = document.getElementById("appliesToCount");
  var addBtn     = document.getElementById("addAppliesToRow");

  if (!container || !countField || !addBtn) return;          // not on this page

  // Read class level options from a JSON script block if available.
  var classLevelOptions = [];
  var optionsScript = document.getElementById("classLevelOptions");
  if (optionsScript) {
    try {
      classLevelOptions = JSON.parse(optionsScript.textContent);
    } catch (e) {
      console.error("Failed to parse classLevelOptions:", e);
    }
  }

  var GRADE_LEVELS = ["PG","1","2","3","4","5","6","7","8","9","10","11","12"];

  // Derive next index from the highest existing data-idx + 1 so edits with
  // pre-rendered rows don't collide.
  var existingIdxs = [];
  container.querySelectorAll(".applies-to-row").forEach(function (row) {
    existingIdxs.push(parseInt(row.getAttribute("data-idx"), 10) || 0);
  });
  var nextIdx = existingIdxs.length ? Math.max.apply(null, existingIdxs) + 1 : 1;

  function buildClassLevelSelect(name, selected) {
    var select = document.createElement("select");
    select.name = name;
    select.className = "class-level-select";
    select.required = true;

    var defaultOpt = document.createElement("option");
    defaultOpt.value = "";
    defaultOpt.textContent = "Select";
    select.appendChild(defaultOpt);

    classLevelOptions.forEach(function (cl) {
      var opt = document.createElement("option");
      opt.value = cl._id;
      var label = cl.name + " (Grade " + cl.gradeLevel +
        (cl.group ? ", " + cl.group : "") +
        (cl.section ? ", " + cl.section : "") + ")";
      opt.textContent = label;
      if (cl._id === selected) opt.selected = true;
      select.appendChild(opt);
    });

    return select;
  }

  function buildGradeLevelSelect(name, selected) {
    var select = document.createElement("select");
    select.name = name;
    select.className = "grade-level-select";
    select.required = true;

    var defaultOpt = document.createElement("option");
    defaultOpt.value = "";
    defaultOpt.textContent = "Select grade";
    select.appendChild(defaultOpt);

    GRADE_LEVELS.forEach(function (g) {
      var opt = document.createElement("option");
      opt.value = g;
      opt.textContent = "Grade " + g;
      if (g === selected) opt.selected = true;
      select.appendChild(opt);
    });

    return select;
  }

  /**
   * Toggle between ClassLevel dropdown and gradeLevel dropdown within a row.
   * The select field container is the first .field in the row.
   */
  function toggleRowType(row, isWholeGrade) {
    var fieldDiv = row.querySelector(".applies-to-field");
    if (!fieldDiv) return;

    // Remove existing select
    var oldSelect = fieldDiv.querySelector("select");
    var idx = row.getAttribute("data-idx");

    if (isWholeGrade) {
      var gradeSelect = buildGradeLevelSelect("gradeLevel_" + idx, "");
      if (oldSelect) fieldDiv.replaceChild(gradeSelect, oldSelect);
      else fieldDiv.appendChild(gradeSelect);
    } else {
      var classSelect = buildClassLevelSelect("classLevel_" + idx, "");
      if (oldSelect) fieldDiv.replaceChild(classSelect, oldSelect);
      else fieldDiv.appendChild(classSelect);
    }
  }

  function updateRemoveButtons() {
    var rows = container.querySelectorAll(".applies-to-row");
    rows.forEach(function (row) {
      var btn = row.querySelector(".remove-row-btn");
      btn.style.display = rows.length > 1 ? "inline-block" : "none";
    });
  }

  /**
   * Build a complete applies-to row.
   * @param {number} idx - Row index
   * @param {object} [opts] - { wholeGrade, classLevelId, gradeLevel, required }
   */
  function buildRow(idx, opts) {
    opts = opts || {};
    var isWholeGrade = !!opts.wholeGrade;

    var row = document.createElement("div");
    row.className = "field-row applies-to-row";
    row.setAttribute("data-idx", idx);

    // --- Field 1: ClassLevel / GradeLevel select ---
    var fieldClass = document.createElement("div");
    fieldClass.className = "field applies-to-field";
    var labelClass = document.createElement("label");
    labelClass.textContent = isWholeGrade ? "Grade level" : "Class level";
    labelClass.className = "applies-to-label";
    fieldClass.appendChild(labelClass);

    if (isWholeGrade) {
      fieldClass.appendChild(buildGradeLevelSelect("gradeLevel_" + idx, opts.gradeLevel || ""));
    } else {
      fieldClass.appendChild(buildClassLevelSelect("classLevel_" + idx, opts.classLevelId || ""));
    }
    row.appendChild(fieldClass);

    // --- Field 2: Whole grade checkbox ---
    var fieldWG = document.createElement("div");
    fieldWG.className = "field";
    fieldWG.style.cssText = "display:flex;align-items:flex-end;";
    var labelWG = document.createElement("label");
    labelWG.style.cssText = "display:flex;align-items:center;gap:6px;";
    var wgCheckbox = document.createElement("input");
    wgCheckbox.type = "checkbox";
    wgCheckbox.name = "wholeGrade_" + idx;
    wgCheckbox.value = "on";
    wgCheckbox.className = "whole-grade-toggle";
    wgCheckbox.checked = isWholeGrade;
    labelWG.appendChild(wgCheckbox);
    labelWG.appendChild(document.createTextNode(" Whole grade (any group)"));
    fieldWG.appendChild(labelWG);
    row.appendChild(fieldWG);

    // --- Field 3: Required checkbox ---
    var fieldReq = document.createElement("div");
    fieldReq.className = "field";
    fieldReq.style.cssText = "display:flex;align-items:flex-end;";
    var labelReq = document.createElement("label");
    labelReq.style.cssText = "display:flex;align-items:center;gap:6px;";
    var reqCheckbox = document.createElement("input");
    reqCheckbox.type = "checkbox";
    reqCheckbox.name = "required_" + idx;
    reqCheckbox.value = "on";
    reqCheckbox.checked = opts.required !== false;
    labelReq.appendChild(reqCheckbox);
    labelReq.appendChild(document.createTextNode(" Required"));
    fieldReq.appendChild(labelReq);
    row.appendChild(fieldReq);

    // --- Field 4: Remove button ---
    var fieldBtn = document.createElement("div");
    fieldBtn.className = "field";
    fieldBtn.style.cssText = "display:flex;align-items:flex-end;";
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn-ghost remove-row-btn";
    btn.style.cssText = "padding:4px 10px;";
    btn.textContent = "Remove";
    fieldBtn.appendChild(btn);
    row.appendChild(fieldBtn);

    // --- Toggle handler ---
    wgCheckbox.addEventListener("change", function () {
      toggleRowType(row, wgCheckbox.checked);
      // Update the label text
      var lbl = row.querySelector(".applies-to-label");
      if (lbl) lbl.textContent = wgCheckbox.checked ? "Grade level" : "Class level";
    });

    return row;
  }

  addBtn.addEventListener("click", function () {
    var idx = nextIdx++;
    var row = buildRow(idx, { wholeGrade: false, required: true });
    container.appendChild(row);
    countField.value = container.querySelectorAll(".applies-to-row").length;
    updateRemoveButtons();
  });

  container.addEventListener("click", function (e) {
    if (e.target.classList.contains("remove-row-btn")) {
      e.target.closest(".applies-to-row").remove();
      countField.value = container.querySelectorAll(".applies-to-row").length;
      updateRemoveButtons();
    }
  });

  updateRemoveButtons();
})();
