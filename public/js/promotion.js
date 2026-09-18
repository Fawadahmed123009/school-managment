(function () {
  var checkboxes = document.querySelectorAll('.student-cb');
  var checkAllHeader = document.getElementById('check-all-header');
  var selectAllBtn = document.getElementById('select-all-btn');
  var deselectAllBtn = document.getElementById('deselect-all-btn');
  var bulkTarget = document.getElementById('bulk-target');
  var bulkApplyBtn = document.getElementById('bulk-apply-btn');
  var promotionForm = document.getElementById('promotion-form');
  var promotionsField = document.getElementById('promotions-field');
  var previewBtn = document.getElementById('preview-btn');
  var changeCount = document.getElementById('change-count');
  var targetSelects = document.querySelectorAll('.target-select');

  if (!promotionForm) return;

  // ── Select all / Deselect all ───────────────────────────────────
  function setAllChecked(checked) {
    checkboxes.forEach(function (cb) { cb.checked = checked; });
    if (checkAllHeader) checkAllHeader.checked = checked;
  }

  if (checkAllHeader) {
    checkAllHeader.addEventListener('change', function () {
      setAllChecked(this.checked);
    });
  }

  if (selectAllBtn) {
    selectAllBtn.addEventListener('click', function () { setAllChecked(true); });
  }
  if (deselectAllBtn) {
    deselectAllBtn.addEventListener('click', function () { setAllChecked(false); });
  }

  // ── Bulk-set: apply chosen target to all checked students ──────
  if (bulkApplyBtn) {
    bulkApplyBtn.addEventListener('click', function () {
      var target = bulkTarget.value;
      if (!target) {
        alert('Please choose a target class or "Graduate" first.');
        return;
      }

      var count = 0;
      checkboxes.forEach(function (cb) {
        if (!cb.checked) return;
        var select = document.querySelector('.target-select[data-student-id="' + cb.value + '"]');
        if (select) {
          select.value = target;
          // Highlight the row to show it has a target set.
          select.style.borderColor = target === 'graduate' ? '#f59e0b' : '#2563eb';
          count++;
        }
      });

      if (count === 0) {
        alert('No students are selected. Tick the checkboxes first.');
        return;
      }

      updateChangeCount();
    });
  }

  // ── Track per-row target changes for visual feedback ───────────
  targetSelects.forEach(function (sel) {
    sel.addEventListener('change', function () {
      var val = this.value;
      if (val === 'graduate') {
        this.style.borderColor = '#f59e0b';
        this.style.backgroundColor = '#fffbeb';
      } else if (val) {
        this.style.borderColor = '#2563eb';
        this.style.backgroundColor = '#eff6ff';
      } else {
        this.style.borderColor = '';
        this.style.backgroundColor = '';
      }
      updateChangeCount();
    });
  });

  // ── Count how many students have a target assigned ─────────────
  function updateChangeCount() {
    var count = 0;
    targetSelects.forEach(function (sel) {
      if (sel.value) count++;
    });
    if (changeCount) {
      changeCount.textContent = count > 0
        ? count + ' student(s) will be ' + (count === 1 ? 'promoted' : 'promoted')
        : '';
    }
  }

  // ── On form submit: serialize promotions into the hidden field ─
  promotionForm.addEventListener('submit', function (e) {
    var promotions = [];
    targetSelects.forEach(function (sel) {
      if (!sel.value) return; // skip students with no target
      promotions.push({
        studentId: sel.dataset.studentId,
        action: sel.value,
      });
    });

    if (promotions.length === 0) {
      e.preventDefault();
      alert('Please assign a target class or "Graduate" to at least one student.');
      return;
    }

    promotionsField.value = JSON.stringify(promotions);

    // Disable the button to prevent double-submits.
    if (previewBtn) {
      previewBtn.disabled = true;
      previewBtn.textContent = 'Loading preview…';
    }
  });

  // Initialize count on page load.
  updateChangeCount();
})();
