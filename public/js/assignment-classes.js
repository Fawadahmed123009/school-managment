// Assignment class-checkbox filtering.
// Externalized from views/assignments/list.ejs so the page carries no inline
// <script> (CSP script-src 'self' blocks unsafe-inline).  Per-request data is
// passed via <script type="application/json"> islands, which CSP does not
// govern because they are not executable.
(function () {
  var subjectSelect = document.getElementById("subject");
  var container = document.getElementById("classCheckboxes");
  var countEl = document.getElementById("selectionCount");
  var form = document.getElementById("assignmentForm");

  // ── Read JSON-island data ────────────────────────────────────
  var subjectClassMap = {};
  try {
    subjectClassMap = JSON.parse(
      document.getElementById("subjectClassMap").textContent
    );
  } catch (e) {}

  var subjectHasAppliesTo = {};
  try {
    subjectHasAppliesTo = JSON.parse(
      document.getElementById("subjectHasAppliesTo").textContent
    );
  } catch (e) {}

  var allClasses = [];
  try {
    allClasses = JSON.parse(
      document.getElementById("allClassesData").textContent
    );
  } catch (e) {}

  var sortedGrades = [];
  try {
    sortedGrades = JSON.parse(
      document.getElementById("sortedGradesData").textContent
    );
  } catch (e) {}

  var classesByGrade = {};
  try {
    classesByGrade = JSON.parse(
      document.getElementById("classesByGradeData").textContent
    );
  } catch (e) {}

  // ── Helpers ──────────────────────────────────────────────────
  function updateCount() {
    var checked = container.querySelectorAll("input.class-checkbox:checked");
    if (checked.length === 0) {
      countEl.textContent = "";
    } else {
      countEl.textContent =
        checked.length + " section" + (checked.length !== 1 ? "s" : "") + " selected";
    }
  }

  function syncGradeAll(grade) {
    var allInGrade = container.querySelectorAll(
      '.class-checkbox[data-grade="' + grade + '"]'
    );
    var checkedInGrade = container.querySelectorAll(
      '.class-checkbox[data-grade="' + grade + '"]:checked'
    );
    var allCb = container.querySelector(
      '.grade-select-all[data-grade="' + grade + '"]'
    );
    if (allCb)
      allCb.checked =
        allInGrade.length > 0 && allInGrade.length === checkedInGrade.length;
  }

  // ── Main render ──────────────────────────────────────────────
  function renderClasses(subjectId) {
    container.innerHTML = "";
    if (!subjectId) {
      container.innerHTML =
        '<p style="color:var(--ink-soft);font-size:13px;margin:0;">Select a subject above to see available classes.</p>';
      updateCount();
      return;
    }

    var allowedIds = subjectClassMap[subjectId] || [];
    var hasAppliesTo = subjectHasAppliesTo[subjectId];

    if (allowedIds.length === 0) {
      if (!hasAppliesTo) {
        container.innerHTML =
          '<div style="padding:8px 0;"><p style="color:var(--error);font-size:13px;margin:0 0 6px;">This subject has no classes configured yet.</p>' +
          '<p style="font-size:13px;margin:0;">Set up its <strong>Applies To</strong> on the <a href="/subjects" style="color:var(--primary);text-decoration:underline;">Subjects page</a> first.</p></div>';
      } else if (allClasses.length === 0) {
        container.innerHTML =
          '<p style="color:var(--ink-soft);font-size:13px;margin:0;">No class sections exist in the system yet. Create classes on the Classes page first.</p>';
      } else {
        container.innerHTML =
          '<p style="color:var(--ink-soft);font-size:13px;margin:0;">No class sections match this subject\'s Applies To configuration.</p>';
      }
      updateCount();
      return;
    }

    var html = "";
    sortedGrades.forEach(function (grade) {
      var gradeClasses = classesByGrade[grade] || [];
      var available = gradeClasses.filter(function (c) {
        return allowedIds.indexOf(c._id) !== -1;
      });
      if (available.length === 0) return;

      html += '<div style="margin-bottom:12px;">';
      html +=
        '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">';
      html +=
        '<label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:var(--ink-soft);margin:0;">';
      html +=
        '<input type="checkbox" class="grade-select-all" data-grade="' +
        grade +
        '"> ';
      html += "Grade " + grade;
      html += "</label>";
      html +=
        '<span style="font-size:11px;color:var(--ink-soft);">(' +
        available.length +
        " section" +
        (available.length !== 1 ? "s" : "") +
        ")</span>";
      html += "</div>";
      html +=
        '<div style="display:flex;flex-wrap:wrap;gap:4px 12px;padding-left:4px;">';
      available.forEach(function (c) {
        var label = c.name;
        if (c.group) label += " \u00b7 " + c.group;
        if (c.section) label += " \u00b7 " + c.section;
        html +=
          '<label style="display:flex;align-items:center;gap:5px;cursor:pointer;font-size:13px;padding:3px 0;margin:0;">';
        html +=
          '<input type="checkbox" name="classLevels" value="' +
          c._id +
          '" class="class-checkbox" data-grade="' +
          grade +
          '"> ';
        html += label;
        html += "</label>";
      });
      html += "</div></div>";
    });

    container.innerHTML = html;

    // Attach event listeners
    container.querySelectorAll(".class-checkbox").forEach(function (cb) {
      cb.addEventListener("change", function () {
        syncGradeAll(this.dataset.grade);
        updateCount();
      });
    });
    container.querySelectorAll(".grade-select-all").forEach(function (cb) {
      cb.addEventListener("change", function () {
        var grade = this.dataset.grade;
        var checked = this.checked;
        container
          .querySelectorAll('.class-checkbox[data-grade="' + grade + '"]')
          .forEach(function (cb) {
            cb.checked = checked;
          });
        updateCount();
      });
    });

    updateCount();
  }

  // ── Event binding ────────────────────────────────────────────
  subjectSelect.addEventListener("change", function () {
    renderClasses(this.value);
  });

  form.addEventListener("submit", function (e) {
    var checked = container.querySelectorAll("input.class-checkbox:checked");
    if (checked.length === 0) {
      e.preventDefault();
      alert("Please select at least one class section.");
    }
  });
})();
