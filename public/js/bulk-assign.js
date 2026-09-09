(function () {
  var targetType = document.getElementById('targetType');
  var classField = document.getElementById('class-field');
  var feeHeadSelect = document.getElementById('feeHead');
  var amountInput = document.getElementById('amount');
  var previewText = document.getElementById('preview-text');
  var form = document.getElementById('bulk-assign-form');
  var submitBtn = document.getElementById('submit-btn');
  var selectAllBtn = document.getElementById('select-all-classes');
  var clearAllBtn = document.getElementById('clear-all-classes');
  var classCount = document.getElementById('class-count');
  var previewPanel = document.getElementById('preview-panel');
  var previewHeading = document.getElementById('preview-heading');
  var previewLoading = document.getElementById('preview-loading');
  var previewBody = document.getElementById('preview-body');
  var classCheckboxes = document.querySelectorAll('.class-cb');
  var perStudentField = document.getElementById('perStudentAmounts');

  // Holds the latest preview data (students list) for form submission
  var lastPreviewData = null;

  if (!targetType || !classField || !feeHeadSelect || !form) return;

  // ── Toggle class field visibility ──────────────────────────────
  function toggleClassField() {
    var isClass = targetType.value === 'class';
    classField.style.display = isClass ? '' : 'none';
  }
  targetType.addEventListener('change', function () {
    toggleClassField();
    schedulePreview();
  });
  toggleClassField();

  // ── Select all / Clear shortcuts ───────────────────────────────
  if (selectAllBtn) {
    selectAllBtn.addEventListener('click', function () {
      classCheckboxes.forEach(function (cb) { cb.checked = true; });
      updateClassCount();
      schedulePreview();
    });
  }
  if (clearAllBtn) {
    clearAllBtn.addEventListener('click', function () {
      classCheckboxes.forEach(function (cb) { cb.checked = false; });
      updateClassCount();
      schedulePreview();
    });
  }

  // ── Count selected classes ─────────────────────────────────────
  function getSelectedClassIds() {
    var ids = [];
    classCheckboxes.forEach(function (cb) {
      if (cb.checked) ids.push(cb.value);
    });
    return ids;
  }

  function updateClassCount() {
    var n = getSelectedClassIds().length;
    if (classCount) {
      classCount.textContent = n > 0 ? n + ' selected' : '';
    }
  }

  // Listen for checkbox changes
  classCheckboxes.forEach(function (cb) {
    cb.addEventListener('change', function () {
      updateClassCount();
      schedulePreview();
    });
  });

  // ── Auto-fill amount from fee head default ─────────────────────
  feeHeadSelect.addEventListener('change', function () {
    var opt = this.options[this.selectedIndex];
    var amt = opt && opt.dataset.amount;
    if (amt && Number(amt) > 0 && !amountInput.value) {
      amountInput.placeholder = 'Default: Rs ' + Number(amt).toLocaleString();
    }
    schedulePreview();
  });

  // Re-render preview (from cache) when group amount changes, so per-student placeholders update
  if (amountInput) {
    amountInput.addEventListener('input', function () {
      if (lastPreviewData) renderPreview(lastPreviewData);
    });
  }

  // ── Preview text (simple one-liner below the form) ─────────────
  function updatePreviewText() {
    var headText = feeHeadSelect.options[feeHeadSelect.selectedIndex]
      ? feeHeadSelect.options[feeHeadSelect.selectedIndex].text : '';
    if (targetType.value === 'class') {
      var n = getSelectedClassIds().length;
      previewText.textContent = headText + (n > 0 ? ' → ' + n + ' class' + (n !== 1 ? 'es' : '') : '');
    } else if (targetType.value === 'all') {
      previewText.textContent = headText + ' → All students';
    } else {
      previewText.textContent = '';
    }
  }

  // ── AJAX preview with debounce ─────────────────────────────────
  var previewTimer = null;

  function schedulePreview() {
    updatePreviewText();
    clearTimeout(previewTimer);
    if (!feeHeadSelect.value) {
      hidePreview();
      return;
    }
    if (targetType.value === 'class' && getSelectedClassIds().length === 0) {
      hidePreview();
      return;
    }
    previewTimer = setTimeout(fetchPreview, 350);
  }

  function hidePreview() {
    if (previewPanel) previewPanel.style.display = 'none';
  }

  function fetchPreview() {
    if (!feeHeadSelect.value) return;

    var payload = {
      feeHead: feeHeadSelect.value,
      targetType: targetType.value,
    };
    if (targetType.value === 'class') {
      payload.classLevel = getSelectedClassIds();
      if (payload.classLevel.length === 0) {
        hidePreview();
        return;
      }
    }

    // Show panel in loading state
    if (previewPanel) {
      previewPanel.style.display = '';
      previewHeading.textContent = 'Preview';
      previewLoading.style.display = '';
      previewLoading.textContent = 'Loading…';
      previewBody.innerHTML = '';
    }

    fetch('/fees/bulk-assign/preview', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': window.CSRF_TOKEN,
      },
      body: JSON.stringify(payload),
    })
      .then(function (res) { return res.json(); })
      .then(function (json) {
        if (!json.ok) {
          previewLoading.textContent = '';
          previewBody.innerHTML = '<div style="padding:16px;color:var(--danger,#c00);font-size:13px;">' +
            escapeHtml(json.error || 'Could not load preview') + '</div>';
          return;
        }
        renderPreview(json.data);
      })
      .catch(function () {
        previewLoading.textContent = '';
        previewBody.innerHTML = '<div style="padding:16px;color:var(--danger,#c00);font-size:13px;">Could not load preview.</div>';
      });
  }

  function renderPreview(data) {
    previewLoading.style.display = 'none';
    lastPreviewData = data;
    var t = data.totals;
    var groupAmount = amountInput.value ? Number(amountInput.value) : data.defaultAmount;
    previewHeading.textContent = 'Preview: ' + t.total + ' student' + (t.total !== 1 ? 's' : '') +
      ' across ' + (data.breakdown.length || (targetType.value === 'all' ? 'all classes' : 'selected classes'));

    var html = '<table style="width:100%;border-collapse:collapse;font-size:13px;">';
    html += '<thead><tr style="border-bottom:1px solid var(--border);text-align:left;">';
    html += '<th style="padding:10px 16px;width:28px;"></th>';
    html += '<th style="padding:10px 16px;">Class</th>';
    html += '<th style="padding:10px 16px;text-align:right;">Total eligible</th>';
    html += '<th style="padding:10px 16px;text-align:right;">New</th>';
    html += '<th style="padding:10px 16px;text-align:right;">Already have it</th>';
    html += '</tr></thead><tbody>';

    // Collect all students for the "all" target type
    var allStudents = data.students || [];

    if (data.breakdown.length > 0) {
      data.breakdown.forEach(function (row, idx) {
        var classRowId = 'class-row-' + idx;
        var hasStudents = row.students && row.students.length > 0;
        html += '<tr style="border-bottom:1px solid var(--border);' + (hasStudents ? 'cursor:pointer;' : '') + '"' +
          (hasStudents ? ' data-toggle-target="' + classRowId + '"' : '') + '>';
        html += '<td style="padding:8px 4px 8px 16px;font-size:11px;color:var(--ink-soft);">' + (hasStudents ? '<span class="chevron">▸</span>' : '') + '</td>';
        html += '<td style="padding:8px 16px;">' + escapeHtml(row.className) + '</td>';
        html += '<td style="padding:8px 16px;text-align:right;">' + row.total + '</td>';
        html += '<td style="padding:8px 16px;text-align:right;color:var(--partial,#2563eb);font-weight:600;">' + row.new + '</td>';
        html += '<td style="padding:8px 16px;text-align:right;color:var(--muted,#888);">' + row.skipped + '</td>';
        html += '</tr>';
        // Expandable per-student row
        if (hasStudents) {
          html += '<tr id="' + classRowId + '" style="display:none;border-bottom:1px solid var(--border);">';
          html += '<td colspan="5" style="padding:0;">';
          html += renderStudentList(row.students, groupAmount, data.feeHeadName);
          html += '</td></tr>';
        }
      });
    } else if (allStudents.length > 0) {
      // "All students" target type — single expandable row
      var allRowId = 'class-row-all';
      html += '<tr style="border-bottom:1px solid var(--border);cursor:pointer;" data-toggle-target="' + allRowId + '">';
      html += '<td style="padding:8px 4px 8px 16px;font-size:11px;color:var(--ink-soft);"><span class="chevron">▸</span></td>';
      html += '<td style="padding:8px 16px;">All students</td>';
      html += '<td style="padding:8px 16px;text-align:right;">' + t.total + '</td>';
      html += '<td style="padding:8px 16px;text-align:right;color:var(--partial,#2563eb);font-weight:600;">' + t.new + '</td>';
      html += '<td style="padding:8px 16px;text-align:right;color:var(--muted,#888);">' + t.skipped + '</td>';
      html += '</tr>';
      html += '<tr id="' + allRowId + '" style="display:none;border-bottom:1px solid var(--border);">';
      html += '<td colspan="5" style="padding:0;">';
      html += renderStudentList(allStudents, groupAmount, data.feeHeadName);
      html += '</td></tr>';
    }

    // Totals row
    html += '<tr style="background:#fafbfd;font-weight:600;">';
    html += '<td></td>';
    html += '<td style="padding:10px 16px;">Total</td>';
    html += '<td style="padding:10px 16px;text-align:right;">' + t.total + '</td>';
    html += '<td style="padding:10px 16px;text-align:right;color:var(--partial,#2563eb);">' + t.new + '</td>';
    html += '<td style="padding:10px 16px;text-align:right;color:var(--muted,#888);">' + t.skipped + '</td>';
    html += '</tr>';

    html += '</tbody></table>';

    if (t.skipped > 0) {
      html += '<div style="padding:10px 16px;font-size:12px;color:var(--muted,#888);border-top:1px solid var(--border);">' +
        t.skipped + ' student(s) already have a "' + escapeHtml(data.feeHeadName) + '" record and will be skipped.</div>';
    }

    html += '<div style="padding:10px 16px;font-size:12px;color:var(--ink-soft);border-top:1px solid var(--border);">' +
      'Click a class row to expand and set per-student amounts. Leave blank to use the group amount (Rs ' +
      Number(groupAmount).toLocaleString() + ').</div>';

    previewBody.innerHTML = html;
  }

  function renderStudentList(students, groupAmount, feeHeadName) {
    var s = '<div style="padding:8px 16px 12px 40px;background:#f5f6f8;max-height:320px;overflow-y:auto;">';
    s += '<table style="width:100%;border-collapse:collapse;font-size:12px;">';
    students.forEach(function (stu) {
      var disabled = stu.hasExisting ? ' disabled' : '';
      var opacity = stu.hasExisting ? 'opacity:0.5;' : '';
      var badge = stu.hasExisting ? ' <span style="font-size:10px;color:var(--muted);margin-left:4px;">(skipped)</span>' : '';
      s += '<tr style="' + opacity + '">';
      s += '<td style="padding:4px 8px;white-space:nowrap;color:var(--ink-soft);">#' + escapeHtml(String(stu.rollNumber || '—')) + '</td>';
      s += '<td style="padding:4px 8px;">' + escapeHtml(stu.name) + badge + '</td>';
      s += '<td style="padding:4px 8px;text-align:right;white-space:nowrap;">';
      s += 'Amount: <input type="number" min="0" class="per-student-amt" data-student-id="' + stu._id + '"' +
        ' placeholder="Rs ' + Number(groupAmount).toLocaleString() + '"' +
        ' style="width:110px;padding:3px 6px;font-size:12px;border:1px solid var(--border);border-radius:4px;"' +
        disabled + ' />';
      s += '</td>';
      s += '</tr>';
    });
    s += '</table></div>';
    return s;
  }

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(str || ''));
    return div.innerHTML;
  }

  // ── Toggle expand/collapse for per-student rows (event delegation) ──
  // Inline onclick is blocked by CSP (Helmet script-src-attr 'none'),
  // so we use a single delegated listener on the preview container.
  function toggleClassStudents(rowId) {
    var row = document.getElementById(rowId);
    if (!row) return;
    var isHidden = row.style.display === 'none';
    row.style.display = isHidden ? '' : 'none';
    // Update the chevron in the parent row
    var parentRow = row.previousElementSibling;
    if (parentRow) {
      var chevron = parentRow.querySelector('.chevron');
      if (chevron) chevron.textContent = isHidden ? '▾' : '▸';
    }
  }

  if (previewBody) {
    previewBody.addEventListener('click', function (e) {
      // Ignore clicks inside the expanded student-list content (the colspan <td>)
      if (e.target.closest('td[colspan]')) return;
      // Ignore clicks on input elements (per-student amount fields)
      if (e.target.tagName === 'INPUT') return;
      // Find the closest <tr> with a data-toggle-target attribute
      var triggerRow = e.target.closest('tr[data-toggle-target]');
      if (!triggerRow) return;
      var targetId = triggerRow.getAttribute('data-toggle-target');
      if (targetId) toggleClassStudents(targetId);
    });
  }

  // ── Collect per-student overrides from inputs ─────────────────
  function collectPerStudentAmounts() {
    var map = {};
    var inputs = previewBody.querySelectorAll('.per-student-amt');
    for (var i = 0; i < inputs.length; i++) {
      var inp = inputs[i];
      if (inp.disabled) continue;
      var val = inp.value.trim();
      if (val !== '' && Number(val) >= 0) {
        map[inp.dataset.studentId] = Number(val);
      }
    }
    return map;
  }

  // ── Form validation on submit ──────────────────────────────────
  form.addEventListener('submit', function (e) {
    if (targetType.value === 'class' && getSelectedClassIds().length === 0) {
      e.preventDefault();
      alert('Please select at least one class.');
      return;
    }
    if (!feeHeadSelect.value) {
      e.preventDefault();
      alert('Please select a fee head.');
      return;
    }
    // Serialize per-student overrides into the hidden field
    var overrides = collectPerStudentAmounts();
    if (perStudentField) {
      perStudentField.value = Object.keys(overrides).length > 0 ? JSON.stringify(overrides) : '';
    }
    submitBtn.disabled = true;
    submitBtn.textContent = 'Creating…';
  });
})();
