// Fee-record form helpers, externalized from views/fees/list.ejs (CSP: the page
// carries no inline <script>). Three behaviours:
//   1. Auto-fill the amount when a fee head with a default is chosen.
//   2. An instant client-side searchable student selector.
//   3. Class and Roll-number filters that narrow the student selector.
// The student list (a few hundred rows) is embedded by the template as a
// non-executed JSON island (#fees-students) and filtered here by class, roll,
// and name/roll combined.
(function () {
  // Auto-fill amount when a fee head with a default is selected
  var feeHead = document.getElementById('feeHead');
  if (feeHead) {
    feeHead.addEventListener('change', function () {
      var opt = this.options[this.selectedIndex];
      var amt = opt && opt.dataset.amount;
      if (amt && Number(amt) > 0) {
        document.getElementById('amount').value = amt;
      }
    });
  }

  // ---- Searchable student selector with class & roll filters ----
  var STUDENTS = (function () {
    var el = document.getElementById('fees-students');
    if (el) { try { return JSON.parse(el.textContent); } catch (e) {} }
    return [];
  })();

  var searchInput  = document.getElementById('student-search');
  var hiddenInput  = document.getElementById('student');
  var resultsBox   = document.getElementById('student-results');
  var classFilter  = document.getElementById('filter-class');
  var rollFilter   = document.getElementById('filter-roll');
  if (!searchInput) return;

  function render(matches) {
    if (matches.length === 0) {
      resultsBox.innerHTML = '<div class="student-search-empty">No matching students</div>';
      resultsBox.style.display = 'block';
      return;
    }
    resultsBox.innerHTML = matches.slice(0, 30).map(function (s) {
      return '<div class="student-search-item" data-id="' + s.id + '" data-label="' + s.name.replace(/"/g, '&quot;') + '">' +
        '<strong>' + s.name + '</strong>' +
        '<span>Roll ' + (s.rollNumber || '—') + ' · ' + s.className + ' (' + s.section + ')</span>' +
        '</div>';
    }).join('');
    resultsBox.style.display = 'block';
  }

  // Central filter function — composes class, roll, and name search
  function applyFilters() {
    hiddenInput.value = ''; // any filter change invalidates previous selection
    var classVal  = classFilter ? classFilter.value : '';
    var rollVal   = rollFilter ? rollFilter.value.trim().toLowerCase() : '';
    var nameVal   = searchInput.value.trim().toLowerCase();

    // Determine whether any filter is active
    var hasFilter = classVal || rollVal || nameVal;
    if (!hasFilter) { resultsBox.style.display = 'none'; return; }

    var matches = STUDENTS.filter(function (s) {
      // Class filter: exact match on classId
      if (classVal && s.classId !== classVal) return false;
      // Roll filter: partial match on rollNumber
      if (rollVal && String(s.rollNumber).toLowerCase().indexOf(rollVal) === -1) return false;
      // Name search: match name or roll number (preserves original behaviour)
      if (nameVal) {
        var hit = s.name.toLowerCase().indexOf(nameVal) !== -1 ||
                  String(s.rollNumber).toLowerCase().indexOf(nameVal) !== -1;
        if (!hit) return false;
      }
      return true;
    });
    render(matches);
  }

  searchInput.addEventListener('input', applyFilters);
  if (classFilter) classFilter.addEventListener('change', applyFilters);
  if (rollFilter)  rollFilter.addEventListener('input', applyFilters);

  resultsBox.addEventListener('click', function (e) {
    var item = e.target.closest('.student-search-item');
    if (!item) return;
    hiddenInput.value = item.dataset.id;
    searchInput.value = item.dataset.label;
    resultsBox.style.display = 'none';
  });

  document.addEventListener('click', function (e) {
    if (e.target !== searchInput && !resultsBox.contains(e.target)) {
      resultsBox.style.display = 'none';
    }
  });

  document.querySelector('form[action="/fees/create"]').addEventListener('submit', function (e) {
    if (!hiddenInput.value) {
      e.preventDefault();
      alert('Please select a student from the search results.');
    }
  });
})();
